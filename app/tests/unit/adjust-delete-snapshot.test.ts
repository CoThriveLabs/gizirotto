/**
 * AdjustView 項目削除振る舞い unit test
 * （段階2-D2・設計書 v2.0 §2-11・ユーザー実機フィードバック #4 復活機能の回帰防止）。
 *
 * 削除ロジックは AdjustView 内のクロージャに閉じているが、**snapshot 構造**だけは pure に
 * 検証可能（fields / values / overrides 同時除去 → 戻るで完全復元）。
 *
 * 検証観点（§2-11）:
 *   - 削除 snapshot を退避 → 復元すると fields / values / overrides が元に戻る
 *   - 削除すると当該 field が dynamicFieldValues 生成対象から外れる（合成入力＝即時非表示）
 *   - 「最後の 1 項目ガード」は呼出側責務（純関数ベースでは fields.length チェックのみ）
 */
import { describe, it, expect } from 'vitest'
import type { TemplateFieldDef } from '@/app/(dashboard)/minutes/[id]/adjust/adjust-view-helpers'
import type { BboxOverrides } from '@/lib/pdf-output/field-override'

type MinutesEditSnapshot = {
  values: Record<string, string>
  overrides: BboxOverrides
  fields: TemplateFieldDef[]
}

function cloneSnapshot(s: MinutesEditSnapshot): MinutesEditSnapshot {
  return {
    values: { ...s.values },
    overrides: Object.fromEntries(
      Object.entries(s.overrides).map(([k, v]) => [k, { ...v }]),
    ),
    fields: s.fields.map((f) => ({ ...f, bbox: { ...f.bbox } })),
  }
}

/**
 * AdjustView の `handleDeleteSelected` と同一ロジックを純関数として再現。
 * 戻り値は「削除後の snapshot」（戻る用の退避は呼出側で別に cloneSnapshot しておく）。
 */
function deleteField(
  snap: MinutesEditSnapshot,
  name: string,
): MinutesEditSnapshot {
  if (snap.fields.length <= 1) return snap // 最後の 1 項目ガード（AdjustView と同方式）
  const fields = snap.fields.filter((f) => f.name !== name)
  const values = { ...snap.values }
  delete values[name]
  const overrides = { ...snap.overrides }
  delete overrides[name]
  return { fields, values, overrides }
}

function makeField(name: string, h = 24): TemplateFieldDef {
  return {
    name,
    label: `項目${name}`,
    bbox: { x: 10, y: 10, w: 100, h },
  }
}

describe('項目削除（§2-11）の snapshot 構造', () => {
  it('削除すると fields / values / overrides からすべて除去される', () => {
    const before: MinutesEditSnapshot = {
      fields: [makeField('a'), makeField('b'), makeField('c')],
      values: { a: 'あ', b: 'い', c: 'う' },
      overrides: { a: { x: 5, y: 5 }, b: { fontSize: 14 } },
    }
    const after = deleteField(before, 'b')
    expect(after.fields.map((f) => f.name)).toEqual(['a', 'c'])
    expect(after.values).toEqual({ a: 'あ', c: 'う' })
    expect(after.overrides).toEqual({ a: { x: 5, y: 5 } })
  })

  it('退避した snapshot を applySnapshot 相当で戻すと完全復元', () => {
    const before: MinutesEditSnapshot = {
      fields: [makeField('a'), makeField('b')],
      values: { a: 'あ', b: 'い' },
      overrides: { b: { fontSize: 16 } },
    }
    const pre = cloneSnapshot(before) // 退避（pushUndo 相当）
    const after = deleteField(before, 'b')
    // 削除後は b が消えている
    expect(after.fields).toHaveLength(1)
    // 戻る = pre をそのまま使う
    const restored = pre
    expect(restored.fields.map((f) => f.name)).toEqual(['a', 'b'])
    expect(restored.values.b).toBe('い')
    expect(restored.overrides.b).toEqual({ fontSize: 16 })
  })

  it('最後の 1 項目は削除されない（fields.length<=1 ガード）', () => {
    const before: MinutesEditSnapshot = {
      fields: [makeField('only')],
      values: { only: 'x' },
      overrides: {},
    }
    const after = deleteField(before, 'only')
    expect(after).toBe(before) // no-op（同参照）
    expect(after.fields).toHaveLength(1)
  })

  it('存在しない field 名は削除しても安全（fields は何も変わらない）', () => {
    const before: MinutesEditSnapshot = {
      fields: [makeField('a'), makeField('b')],
      values: { a: 'あ' },
      overrides: {},
    }
    const after = deleteField(before, 'ghost')
    expect(after.fields.map((f) => f.name)).toEqual(['a', 'b'])
    expect(after.values).toEqual({ a: 'あ' })
  })

  it('cloneSnapshot は深いコピー（戻る後に新ステート変更しても snapshot が汚染されない）', () => {
    const original: MinutesEditSnapshot = {
      fields: [makeField('a')],
      values: { a: 'first' },
      overrides: { a: { x: 1 } },
    }
    const copy = cloneSnapshot(original)
    original.values.a = 'mutated'
    original.overrides.a.x = 999
    original.fields[0].bbox.x = 999
    expect(copy.values.a).toBe('first')
    expect(copy.overrides.a.x).toBe(1)
    expect(copy.fields[0].bbox.x).toBe(10)
  })
})

describe('項目削除後の dynamicFieldValues 生成（合成入力から外れる）', () => {
  /**
   * AdjustView の dynamicFieldValues useMemo と同等ロジック（合成入力生成）。
   * 削除した field は fields 配列から消えるので、合成入力にも自動で出ない。
   */
  function buildDynamicFieldValueNames(snap: MinutesEditSnapshot): string[] {
    return snap.fields
      .filter((f) => (snap.values[f.name] ?? '').trim() !== '')
      .map((f) => f.name)
  }

  it('削除直後の合成入力に当該 field が含まれない（焼き込み撤回不要・即非表示）', () => {
    const before: MinutesEditSnapshot = {
      fields: [makeField('a'), makeField('b'), makeField('c')],
      values: { a: 'あ', b: 'い', c: 'う' },
      overrides: {},
    }
    expect(buildDynamicFieldValueNames(before)).toEqual(['a', 'b', 'c'])
    const after = deleteField(before, 'b')
    expect(buildDynamicFieldValueNames(after)).toEqual(['a', 'c'])
  })
})
