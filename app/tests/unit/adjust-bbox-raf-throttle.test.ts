/**
 * bbox 移動 RAF 間引き unit test
 *
 * 問題: bbox 移動中文字が追従しない（pointermove 60+ fps の setOverrides 連発で
 *       useMemo / useEffect 重連鎖が CPU 占有 → フレーム破綻）
 *
 * 仕様:
 *   - handleChangeBbox → latestBboxRef.current.set(name, bbox) + RAF schedule のみ
 *   - flushBboxChanges で次フレーム頭に Map を畳んで setOverrides を 1 回だけ呼ぶ
 *   - pointerup（handleDragCommit）で残バッファ同期 flush + RAF cancel
 *   - unmount で RAF cancel（リーク防止）
 *
 * テスト対象:
 *   1. `applyBboxFlushUpdates`（実装と単一実装の純関数）の畳み込み仕様
 *   2. RAF 間引き挙動（schedule → flush → 連続呼出でも 1 回 schedule）
 *
 * 厳守:
 *   - field-override.ts / bbox-pane.tsx / required-bbox-height.ts は不変
 *   - undo/redo 経路（dragPreSnapshotRef）に手を入れていない
 *   - 1:1 互換: 旧 handleChangeBbox の動作（tmpl lookup + w/h 差分判定 + 不存在 skip）を保持
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  applyBboxFlushUpdates,
  type TemplateFieldDef,
} from '@/app/(dashboard)/minutes/[id]/adjust/AdjustView'
import type { BboxOverrides } from '@/lib/pdf-output/field-override'

const FIELDS: TemplateFieldDef[] = [
  {
    name: 'a',
    label: 'A',
    bbox: { x: 0, y: 0, w: 100, h: 20 },
    multiline: false,
  },
  {
    name: 'b',
    label: 'B',
    bbox: { x: 0, y: 0, w: 150, h: 30 },
    multiline: true,
  },
]

describe('applyBboxFlushUpdates（D11 純関数）', () => {
  it('空 Map を受けたら prev と参照同一を返す（不要な再 render 抑止）', () => {
    const prev: BboxOverrides = {}
    const result = applyBboxFlushUpdates(prev, new Map(), FIELDS)
    expect(result).toBe(prev)
  })

  it('1 件の update を畳み込む: x/y は常に書く、w/h は tmpl と同じなら書かない', () => {
    const prev: BboxOverrides = {}
    const updates = new Map([
      ['a', { x: 10, y: 20, w: 100, h: 20, page: 1 }], // w/h は tmpl 素値
    ])
    const result = applyBboxFlushUpdates(prev, updates, FIELDS)
    expect(result).not.toBe(prev)
    expect(result.a).toEqual({ x: 10, y: 20 })
    expect(result.a.w).toBeUndefined()
    expect(result.a.h).toBeUndefined()
  })

  it('w/h が tmpl と異なる場合は w/h も書く（リサイズ確定）', () => {
    const prev: BboxOverrides = {}
    const updates = new Map([
      ['a', { x: 10, y: 20, w: 120, h: 22, page: 1 }],
    ])
    const result = applyBboxFlushUpdates(prev, updates, FIELDS)
    expect(result.a).toEqual({ x: 10, y: 20, w: 120, h: 22 })
  })

  it('既存 override の他プロパティ（fontSize 等）は保持する', () => {
    const prev: BboxOverrides = { a: { fontSize: 14, h: 25 } }
    const updates = new Map([
      ['a', { x: 10, y: 20, w: 100, h: 20, page: 1 }], // h は tmpl 素値 = h プロパティを書かない
    ])
    const result = applyBboxFlushUpdates(prev, updates, FIELDS)
    expect(result.a).toEqual({ fontSize: 14, h: 25, x: 10, y: 20 })
  })

  it('複数 field を 1 回で畳み込む（pointermove で並行 drag された場合）', () => {
    const prev: BboxOverrides = {}
    const updates = new Map([
      ['a', { x: 1, y: 2, w: 100, h: 20, page: 1 }],
      ['b', { x: 3, y: 4, w: 160, h: 30, page: 1 }], // w だけ異なる
    ])
    const result = applyBboxFlushUpdates(prev, updates, FIELDS)
    expect(result.a).toEqual({ x: 1, y: 2 })
    expect(result.b).toEqual({ x: 3, y: 4, w: 160 })
  })

  it('不存在 field（削除直後など）は skip（旧 handleChangeBbox の防御を維持）', () => {
    const prev: BboxOverrides = { a: { fontSize: 12 } }
    const updates = new Map([
      ['ghost', { x: 99, y: 99, w: 1, h: 1, page: 1 }],
    ])
    const result = applyBboxFlushUpdates(prev, updates, FIELDS)
    // 適用 0 件 → prev と参照同一
    expect(result).toBe(prev)
  })

  it('適用される update と skip される update が混在する場合、適用分のみ反映される', () => {
    const prev: BboxOverrides = {}
    const updates = new Map([
      ['ghost', { x: 99, y: 99, w: 1, h: 1, page: 1 }],
      ['a', { x: 5, y: 6, w: 100, h: 20, page: 1 }],
    ])
    const result = applyBboxFlushUpdates(prev, updates, FIELDS)
    expect(result).not.toBe(prev)
    expect(result.a).toEqual({ x: 5, y: 6 })
    expect(result.ghost).toBeUndefined()
  })
})

/**
 * RAF 間引き挙動の検証（案 A 中核仕様）。
 *
 * 実 React コンポーネントを mount せず、案 A と同型の最小実装で RAF API スタブで
 * 「連続呼出でも schedule は 1 回」「flush 後は再 schedule できる」「cancel で flush が
 * 走らない」を検証する。実装側（AdjustView.tsx の flushBboxChanges / handleChangeBbox /
 * handleDragCommit）は同じ pattern を使うため、ここで挙動を担保する。
 */
describe('RAF 間引き挙動（D11 案 A）', () => {
  let rafCallbacks: Map<number, FrameRequestCallback>
  let rafCounter: number

  beforeEach(() => {
    rafCallbacks = new Map()
    rafCounter = 0
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: FrameRequestCallback): number => {
        rafCounter += 1
        rafCallbacks.set(rafCounter, cb)
        return rafCounter
      },
    )
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      rafCallbacks.delete(id)
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** 案 A と同型の最小実装（テスト対象シミュレーション）。 */
  function createThrottle(
    fields: TemplateFieldDef[],
    initialOverrides: BboxOverrides = {},
  ) {
    const latestBboxRef = {
      current: new Map<
        string,
        { x: number; y: number; w: number; h: number; page: number }
      >(),
    }
    const rafIdRef: { current: number | null } = { current: null }
    let overrides: BboxOverrides = initialOverrides
    let setOverridesCallCount = 0

    const flushBboxChanges = () => {
      rafIdRef.current = null
      if (latestBboxRef.current.size === 0) return
      const updates = new Map(latestBboxRef.current)
      latestBboxRef.current.clear()
      const next = applyBboxFlushUpdates(overrides, updates, fields)
      // applyBboxFlushUpdates が prev と同参照なら React も bailout する想定
      if (next !== overrides) {
        overrides = next
        setOverridesCallCount += 1
      }
    }

    const handleChangeBbox = (
      name: string,
      bbox: { x: number; y: number; w: number; h: number; page: number },
    ) => {
      latestBboxRef.current.set(name, bbox)
      if (rafIdRef.current === null) {
        rafIdRef.current = requestAnimationFrame(flushBboxChanges)
      }
    }

    const handleDragCommit = () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
      if (latestBboxRef.current.size > 0) {
        flushBboxChanges()
      }
    }

    const unmount = () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
    }

    return {
      handleChangeBbox,
      handleDragCommit,
      unmount,
      getOverrides: () => overrides,
      getSetOverridesCallCount: () => setOverridesCallCount,
      getPendingRafCount: () => rafCallbacks.size,
      getRafId: () => rafIdRef.current,
    }
  }

  function flushFrame() {
    // 1 フレーム経過: 登録済 callback を全部呼ぶ（実 RAF と同等の単発実行）。
    const callbacks = Array.from(rafCallbacks.values())
    rafCallbacks.clear()
    callbacks.forEach((cb) => cb(performance.now()))
  }

  it('連続 handleChangeBbox 呼出でも RAF は 1 回しか schedule されない', () => {
    const t = createThrottle(FIELDS)
    for (let i = 0; i < 100; i++) {
      t.handleChangeBbox('a', {
        x: i,
        y: 0,
        w: 100,
        h: 20,
        page: 1,
      })
    }
    expect(t.getPendingRafCount()).toBe(1)
    expect(t.getSetOverridesCallCount()).toBe(0) // まだ flush していない
  })

  it('RAF flush 後に setOverrides が 1 回呼ばれ、最終値が反映される', () => {
    const t = createThrottle(FIELDS)
    for (let i = 0; i < 100; i++) {
      t.handleChangeBbox('a', {
        x: i,
        y: i * 2,
        w: 100,
        h: 20,
        page: 1,
      })
    }
    flushFrame()
    expect(t.getSetOverridesCallCount()).toBe(1)
    // 最終値（i=99）が反映される
    expect(t.getOverrides().a).toEqual({ x: 99, y: 198 })
  })

  it('flush 後に再度 handleChangeBbox を呼ぶと再 schedule される', () => {
    const t = createThrottle(FIELDS)
    t.handleChangeBbox('a', { x: 1, y: 1, w: 100, h: 20, page: 1 })
    flushFrame()
    expect(t.getPendingRafCount()).toBe(0)
    expect(t.getRafId()).toBeNull()

    t.handleChangeBbox('a', { x: 2, y: 2, w: 100, h: 20, page: 1 })
    expect(t.getPendingRafCount()).toBe(1)
    flushFrame()
    expect(t.getSetOverridesCallCount()).toBe(2)
    expect(t.getOverrides().a).toEqual({ x: 2, y: 2 })
  })

  it('handleDragCommit で残バッファが同期 flush され RAF が cancel される', () => {
    const t = createThrottle(FIELDS)
    t.handleChangeBbox('a', { x: 5, y: 6, w: 100, h: 20, page: 1 })
    expect(t.getPendingRafCount()).toBe(1)
    expect(t.getSetOverridesCallCount()).toBe(0)

    t.handleDragCommit()
    // RAF は cancel されて pending 0
    expect(t.getPendingRafCount()).toBe(0)
    expect(t.getRafId()).toBeNull()
    // 残バッファが同期 flush され setOverrides 1 回
    expect(t.getSetOverridesCallCount()).toBe(1)
    expect(t.getOverrides().a).toEqual({ x: 5, y: 6 })
  })

  it('handleDragCommit でバッファ空なら flush しない（不要な setState 抑止）', () => {
    const t = createThrottle(FIELDS)
    t.handleDragCommit()
    expect(t.getSetOverridesCallCount()).toBe(0)
    expect(t.getPendingRafCount()).toBe(0)
  })

  it('unmount で RAF cancel される（リーク防止）', () => {
    const t = createThrottle(FIELDS)
    t.handleChangeBbox('a', { x: 5, y: 6, w: 100, h: 20, page: 1 })
    expect(t.getPendingRafCount()).toBe(1)

    t.unmount()
    expect(t.getPendingRafCount()).toBe(0)
    expect(t.getRafId()).toBeNull()
    // unmount 後にフレームを進めても callback は走らない（cancel 済）
    flushFrame()
    expect(t.getSetOverridesCallCount()).toBe(0)
  })

  it('複数 field の並行 drag: 各 field の最終値が 1 回の flush で反映される', () => {
    const t = createThrottle(FIELDS)
    // pointermove が a と b に交互に来るシミュレーション
    for (let i = 0; i < 50; i++) {
      t.handleChangeBbox('a', { x: i, y: 0, w: 100, h: 20, page: 1 })
      t.handleChangeBbox('b', { x: 0, y: i, w: 150, h: 30, page: 1 })
    }
    expect(t.getPendingRafCount()).toBe(1)
    flushFrame()
    expect(t.getSetOverridesCallCount()).toBe(1)
    expect(t.getOverrides().a).toEqual({ x: 49, y: 0 })
    expect(t.getOverrides().b).toEqual({ x: 0, y: 49 })
  })

  it('既存 override の他プロパティ（fontSize）が drag flush で消えない', () => {
    const initial: BboxOverrides = { a: { fontSize: 14 } }
    const t = createThrottle(FIELDS, initial)
    t.handleChangeBbox('a', { x: 7, y: 8, w: 100, h: 20, page: 1 })
    flushFrame()
    expect(t.getOverrides().a).toEqual({ fontSize: 14, x: 7, y: 8 })
  })
})
