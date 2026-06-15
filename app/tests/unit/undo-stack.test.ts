import { describe, it, expect } from 'vitest'
import {
  type EditSnapshot,
  type LayerSnapshot,
  UNDO_STACK_LIMIT,
  NUDGE_COALESCE_MS,
  cloneSnapshot,
  pushSnapshot,
  popSnapshot,
  shouldCoalesceNudge,
  cloneLayerSnapshot,
  pushLayerSnapshot,
  popLayerSnapshot,
} from '@/lib/pdf-output/undo-stack'

// undo スタック純ロジックの担保。
// push / coalesce / pop / FIFO上限 / 複製独立性 / coalesce 判定 を検証する。

/** テスト用スナップショット生成（fields は name と x だけ持つ軽量形）。 */
function snap(names: string[], opts?: { neu?: string[]; dirty?: string[] }): EditSnapshot {
  return {
    fields: names.map((name, i) => ({
      name,
      label: name,
      bbox: { x: i, y: 0, w: 10, h: 10, page: 1 },
    })),
    newFieldNames: opts?.neu ?? [],
    labelDirtyNames: opts?.dirty ?? [],
  }
}

describe('cloneSnapshot（複製独立性）', () => {
  it('fields/付随集合が参照共有でなく独立に複製される', () => {
    const a = snap(['field_1'], { neu: ['field_1'], dirty: ['field_2'] })
    const b = cloneSnapshot(a)
    expect(b).toEqual(a)
    expect(b.fields).not.toBe(a.fields)
    expect(b.fields[0]).not.toBe(a.fields[0])
    expect(b.fields[0].bbox).not.toBe(a.fields[0].bbox)
    expect(b.newFieldNames).not.toBe(a.newFieldNames)
    expect(b.labelDirtyNames).not.toBe(a.labelDirtyNames)
    // 複製を変更しても元が汚染されない。
    b.fields[0].bbox.x = 999
    b.newFieldNames.push('field_x')
    expect(a.fields[0].bbox.x).toBe(0)
    expect(a.newFieldNames).toEqual(['field_1'])
  })
})

describe('pushSnapshot（push / FIFO上限）', () => {
  it('通常 push は末尾へ append し新配列を返す（元配列は不変）', () => {
    const s0: EditSnapshot[] = []
    const s1 = pushSnapshot(s0, snap(['a']))
    expect(s1).not.toBe(s0)
    expect(s1).toHaveLength(1)
    expect(s0).toHaveLength(0)
    const s2 = pushSnapshot(s1, snap(['a', 'b']))
    expect(s2).toHaveLength(2)
    expect(s2[1].fields.map((f) => f.name)).toEqual(['a', 'b'])
  })

  it('push されるのは複製（呼び出し後に元 snap を変更しても積んだ分は不変）', () => {
    const src = snap(['a'], { neu: ['a'] })
    const stack = pushSnapshot([], src)
    src.fields[0].bbox.x = 777
    src.newFieldNames.push('z')
    expect(stack[0].fields[0].bbox.x).toBe(0)
    expect(stack[0].newFieldNames).toEqual(['a'])
  })

  it('上限超過は最古（先頭）から FIFO で落とす', () => {
    let stack: EditSnapshot[] = []
    for (let i = 0; i < UNDO_STACK_LIMIT + 5; i++) {
      stack = pushSnapshot(stack, snap([`f${i}`]))
    }
    expect(stack).toHaveLength(UNDO_STACK_LIMIT)
    // 最古5件が落ち、トップは最新。
    expect(stack[0].fields[0].name).toBe('f5')
    expect(stack[stack.length - 1].fields[0].name).toBe(
      `f${UNDO_STACK_LIMIT + 4}`,
    )
  })

  it('limit を明示指定できる', () => {
    let stack: EditSnapshot[] = []
    for (let i = 0; i < 5; i++) stack = pushSnapshot(stack, snap([`f${i}`]), { limit: 3 })
    expect(stack).toHaveLength(3)
    expect(stack[0].fields[0].name).toBe('f2')
  })
})

describe('pushSnapshot coalesce', () => {
  it('coalesce=true かつ スタック非空なら積まない（トップ温存）', () => {
    const base = pushSnapshot([], snap(['before'])) // 連続nudceの最初の押下前
    const after = pushSnapshot(base, snap(['after']), { coalesce: true })
    expect(after).toBe(base) // 同一参照＝何も積まれない
    expect(after).toHaveLength(1)
    expect(after[0].fields[0].name).toBe('before')
  })

  it('coalesce=true でもスタックが空なら通常 push（最初の nudge）', () => {
    const stack = pushSnapshot([], snap(['first']), { coalesce: true })
    expect(stack).toHaveLength(1)
    expect(stack[0].fields[0].name).toBe('first')
  })
})

describe('popSnapshot', () => {
  it('トップを取り出し残りを返す', () => {
    const stack = [snap(['a']), snap(['b']), snap(['c'])]
    const { snap: top, rest } = popSnapshot(stack)
    expect(top?.fields[0].name).toBe('c')
    expect(rest.map((s) => s.fields[0].name)).toEqual(['a', 'b'])
  })

  it('空スタックは snap=null・rest はそのまま', () => {
    const { snap: top, rest } = popSnapshot([])
    expect(top).toBeNull()
    expect(rest).toHaveLength(0)
  })
})

describe('shouldCoalesceNudge', () => {
  it('直前が nudge・同一 name・時間窓内なら true', () => {
    const last = { kind: 'nudge' as const, name: 'field_1', at: 1000 }
    expect(
      shouldCoalesceNudge(last, { name: 'field_1', now: 1000 + NUDGE_COALESCE_MS - 1 }),
    ).toBe(true)
  })

  it('時間窓を超えたら false（新ステップ）', () => {
    const last = { kind: 'nudge' as const, name: 'field_1', at: 1000 }
    expect(
      shouldCoalesceNudge(last, { name: 'field_1', now: 1000 + NUDGE_COALESCE_MS }),
    ).toBe(false)
  })

  it('直前が別操作（other）なら false', () => {
    const last = { kind: 'other' as const, name: 'field_1', at: 1000 }
    expect(shouldCoalesceNudge(last, { name: 'field_1', now: 1100 })).toBe(false)
  })

  it('別の枠（name 不一致）なら false', () => {
    const last = { kind: 'nudge' as const, name: 'field_1', at: 1000 }
    expect(shouldCoalesceNudge(last, { name: 'field_2', now: 1100 })).toBe(false)
  })

  it('last=null（履歴なし）なら false', () => {
    expect(shouldCoalesceNudge(null, { name: 'field_1', now: 1100 })).toBe(false)
  })
})

// ── 白塗り/固定テキスト用の汎用レイヤ undo スタック ──────────────

interface DummyMeta {
  value: string
  flag?: boolean
}

/** テスト用レイヤ snapshot（fields は name/x、meta は [name, {value}] のタプル配列）。 */
function layer(
  names: string[],
  metaEntries?: Array<[string, DummyMeta]>,
): LayerSnapshot<DummyMeta> {
  return {
    fields: names.map((name, i) => ({
      name,
      label: name,
      bbox: { x: i, y: 0, w: 10, h: 10, page: 1 },
    })),
    meta: metaEntries ?? [],
  }
}

describe('cloneLayerSnapshot（複製独立性）', () => {
  it('fields/meta が参照共有でなく独立に複製される', () => {
    const a = layer(['ft_0'], [['ft_0', { value: 'hello' }]])
    const b = cloneLayerSnapshot(a)
    expect(b).toEqual(a)
    expect(b.fields).not.toBe(a.fields)
    expect(b.fields[0].bbox).not.toBe(a.fields[0].bbox)
    expect(b.meta).not.toBe(a.meta)
    expect(b.meta[0][1]).not.toBe(a.meta[0][1])
    // 複製を変更しても元が汚染されない。
    b.fields[0].bbox.x = 999
    b.meta[0][1].value = 'changed'
    expect(a.fields[0].bbox.x).toBe(0)
    expect(a.meta[0][1].value).toBe('hello')
  })
})

describe('pushLayerSnapshot（push / FIFO上限）', () => {
  it('通常 push は末尾へ append し新配列を返す（元配列は不変）', () => {
    const s0: LayerSnapshot<DummyMeta>[] = []
    const s1 = pushLayerSnapshot(s0, layer(['a']))
    expect(s1).not.toBe(s0)
    expect(s1).toHaveLength(1)
    expect(s0).toHaveLength(0)
  })

  it('push されるのは複製（呼び出し後に元 snap を変更しても積んだ分は不変）', () => {
    const src = layer(['a'], [['a', { value: 'x' }]])
    const stack = pushLayerSnapshot([], src)
    src.fields[0].bbox.x = 777
    src.meta[0][1].value = 'y'
    expect(stack[0].fields[0].bbox.x).toBe(0)
    expect(stack[0].meta[0][1].value).toBe('x')
  })

  it('上限超過は最古（先頭）から FIFO で落とす', () => {
    let stack: LayerSnapshot<DummyMeta>[] = []
    for (let i = 0; i < UNDO_STACK_LIMIT + 3; i++) {
      stack = pushLayerSnapshot(stack, layer([`f${i}`]))
    }
    expect(stack).toHaveLength(UNDO_STACK_LIMIT)
    expect(stack[0].fields[0].name).toBe('f3')
  })

  it('limit を明示指定できる', () => {
    let stack: LayerSnapshot<DummyMeta>[] = []
    for (let i = 0; i < 5; i++) {
      stack = pushLayerSnapshot(stack, layer([`f${i}`]), { limit: 2 })
    }
    expect(stack).toHaveLength(2)
    expect(stack[0].fields[0].name).toBe('f3')
  })
})

describe('popLayerSnapshot', () => {
  it('トップを取り出し残りを返す', () => {
    const stack = [layer(['a']), layer(['b']), layer(['c'])]
    const { snap: top, rest } = popLayerSnapshot(stack)
    expect(top?.fields[0].name).toBe('c')
    expect(rest.map((s) => s.fields[0].name)).toEqual(['a', 'b'])
  })

  it('空スタックは snap=null', () => {
    const { snap: top, rest } = popLayerSnapshot<DummyMeta>([])
    expect(top).toBeNull()
    expect(rest).toHaveLength(0)
  })
})

describe('レイヤ undo/redo 往復（meta も巻き戻る）', () => {
  it('value 編集を push→undo で戻し、redo で進む（meta 含む）', () => {
    const A = layer(['ft_0'], [['ft_0', { value: '' }]])
    const B = layer(['ft_0'], [['ft_0', { value: 'AB' }]])

    let undo: LayerSnapshot<DummyMeta>[] = []
    let redo: LayerSnapshot<DummyMeta>[] = []
    let current = A

    // A→B（B 適用前に A を push）
    undo = pushLayerSnapshot(undo, current)
    current = B
    expect(current.meta[0][1].value).toBe('AB')

    // undo: A へ戻り、現在(B)を redo へ
    {
      const { snap: prev, rest } = popLayerSnapshot(undo)
      redo = pushLayerSnapshot(redo, current)
      current = prev!
      undo = rest
    }
    expect(current.meta[0][1].value).toBe('')
    expect(undo).toHaveLength(0)

    // redo: B へ進む
    {
      const { snap: next, rest } = popLayerSnapshot(redo)
      undo = pushLayerSnapshot(undo, current)
      current = next!
      redo = rest
    }
    expect(current.meta[0][1].value).toBe('AB')
  })
})

describe('undo/redo 往復（純ロジック合成）', () => {
  it('push→pop（undo）で直前へ戻り、退避→pop（redo）で進む', () => {
    // 初期 A、操作で B、操作で C と進めるシミュレーション（before-snapshot 方式）。
    const A = snap(['A'])
    const B = snap(['B'])
    const C = snap(['C'])

    let undo: EditSnapshot[] = []
    let redo: EditSnapshot[] = []
    let current = A

    // A→B（B 適用前に A を push）
    undo = pushSnapshot(undo, current)
    current = B
    // B→C（C 適用前に B を push）
    undo = pushSnapshot(undo, current)
    current = C
    expect(undo.map((s) => s.fields[0].name)).toEqual(['A', 'B'])

    // undo: トップ(B)へ戻し、現在(C)を redo へ
    {
      const { snap: prev, rest } = popSnapshot(undo)
      redo = pushSnapshot(redo, current)
      current = prev!
      undo = rest
    }
    expect(current.fields[0].name).toBe('B')
    expect(redo.map((s) => s.fields[0].name)).toEqual(['C'])

    // undo もう1回: A へ
    {
      const { snap: prev, rest } = popSnapshot(undo)
      redo = pushSnapshot(redo, current)
      current = prev!
      undo = rest
    }
    expect(current.fields[0].name).toBe('A')
    expect(undo).toHaveLength(0)

    // redo: B へ進む
    {
      const { snap: next, rest } = popSnapshot(redo)
      undo = pushSnapshot(undo, current)
      current = next!
      redo = rest
    }
    expect(current.fields[0].name).toBe('B')
  })
})
