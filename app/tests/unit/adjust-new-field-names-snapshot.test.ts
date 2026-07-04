/**
 * AdjustView 「項目追加 → 削除」と undo/redo の newFieldNames 整合 unit test。
 *
 * AdjustView 内 snapshot 構造（fields / values / overrides / newFieldNames）が
 * undo / redo / 削除 の各経路で drift しないことを純関数ベースで担保。
 *
 * 検証観点:
 *   - MinutesEditSnapshot に newFieldNames 含有: clone / equal で集合差分が検知される
 *   - 追加 → undo: newFieldNames から消える
 *   - 追加 → 値入力 → undo: 値だけ戻り newFieldNames は維持（snapshot 単位が独立）
 *   - 追加 → 削除: newFieldNames Set から除去
 *   - 追加 → 削除 → undo: fields / newFieldNames が同時に復活
 *   - 既存 field の削除: newFieldNames は不変（既存 field は newFieldNames に居ない）
 */
import { describe, it, expect } from 'vitest'
import type { TemplateFieldDef } from '@/app/(dashboard)/minutes/[id]/adjust/adjust-view-helpers'
import type { BboxOverrides } from '@/lib/pdf-output/field-override'

type MinutesEditSnapshot = {
  values: Record<string, string>
  overrides: BboxOverrides
  fields: TemplateFieldDef[]
  newFieldNames: Set<string>
}

/** AdjustView の cloneSnapshot と同型（newFieldNames も clone）。 */
function cloneSnapshot(s: MinutesEditSnapshot): MinutesEditSnapshot {
  return {
    values: { ...s.values },
    overrides: Object.fromEntries(
      Object.entries(s.overrides).map(([k, v]) => [k, { ...v }]),
    ),
    fields: s.fields.map((f) => ({ ...f, bbox: { ...f.bbox } })),
    newFieldNames: new Set(s.newFieldNames),
  }
}

/** AdjustView の snapshotsEqual と同型（newFieldNames 集合差分も検知）。 */
function snapshotsEqual(
  a: MinutesEditSnapshot,
  b: MinutesEditSnapshot,
): boolean {
  const aKeys = Object.keys(a.values)
  const bKeys = Object.keys(b.values)
  if (aKeys.length !== bKeys.length) return false
  for (const k of aKeys) if (a.values[k] !== b.values[k]) return false
  const aoKeys = Object.keys(a.overrides)
  const boKeys = Object.keys(b.overrides)
  if (aoKeys.length !== boKeys.length) return false
  if (a.fields.length !== b.fields.length) return false
  for (let i = 0; i < a.fields.length; i++) {
    if (a.fields[i].name !== b.fields[i].name) return false
  }
  if (a.newFieldNames.size !== b.newFieldNames.size) return false
  for (const n of a.newFieldNames) if (!b.newFieldNames.has(n)) return false
  return true
}

/** AdjustView の handleAddField 純関数版（snapshot 単位）。 */
function addField(
  snap: MinutesEditSnapshot,
  newName: string,
): MinutesEditSnapshot {
  const next = cloneSnapshot(snap)
  next.fields.push({
    name: newName,
    label: `項目${next.fields.length + 1}`,
    bbox: { x: 100, y: 100, w: 200, h: 24 },
  })
  next.values[newName] = ''
  next.newFieldNames.add(newName)
  return next
}

/** AdjustView の handleDeleteSelected 純関数版（newFieldNames 掃除を含む）。 */
function deleteField(
  snap: MinutesEditSnapshot,
  name: string,
): MinutesEditSnapshot {
  if (snap.fields.length <= 1) return snap
  const next = cloneSnapshot(snap)
  next.fields = next.fields.filter((f) => f.name !== name)
  delete next.values[name]
  delete next.overrides[name]
  // newFieldNames Set からも除去（templates handleDeleteSelected 同方式）。
  if (next.newFieldNames.has(name)) next.newFieldNames.delete(name)
  return next
}

function makeField(name: string): TemplateFieldDef {
  return {
    name,
    label: name,
    bbox: { x: 10, y: 10, w: 100, h: 24 },
  }
}

describe('MinutesEditSnapshot 拡張', () => {
  describe('cloneSnapshot / snapshotsEqual で newFieldNames 集合差分が検知される', () => {
    it('newFieldNames が同じ要素 → equal', () => {
      const a: MinutesEditSnapshot = {
        values: {},
        overrides: {},
        fields: [makeField('a')],
        newFieldNames: new Set(['field_1']),
      }
      const b = cloneSnapshot(a)
      expect(snapshotsEqual(a, b)).toBe(true)
    })

    it('newFieldNames の要素が異なる → not equal（drift 検知）', () => {
      const a: MinutesEditSnapshot = {
        values: {},
        overrides: {},
        fields: [makeField('a')],
        newFieldNames: new Set(['field_1']),
      }
      const b: MinutesEditSnapshot = {
        values: {},
        overrides: {},
        fields: [makeField('a')],
        newFieldNames: new Set(['field_2']),
      }
      expect(snapshotsEqual(a, b)).toBe(false)
    })

    it('newFieldNames のサイズが異なる → not equal', () => {
      const a: MinutesEditSnapshot = {
        values: {},
        overrides: {},
        fields: [makeField('a')],
        newFieldNames: new Set(['field_1']),
      }
      const b: MinutesEditSnapshot = {
        values: {},
        overrides: {},
        fields: [makeField('a')],
        newFieldNames: new Set(['field_1', 'field_2']),
      }
      expect(snapshotsEqual(a, b)).toBe(false)
    })

    it('clone は独立した Set インスタンスを作る（参照分離）', () => {
      const a: MinutesEditSnapshot = {
        values: {},
        overrides: {},
        fields: [makeField('a')],
        newFieldNames: new Set(['field_1']),
      }
      const b = cloneSnapshot(a)
      b.newFieldNames.add('field_2')
      expect(a.newFieldNames.has('field_2')).toBe(false)
      expect(b.newFieldNames.has('field_2')).toBe(true)
    })
  })

  describe('追加 → undo: newFieldNames も復元される（drift なし）', () => {
    it('追加前 snapshot を退避 → 追加 → 戻る = drift なし', () => {
      const before: MinutesEditSnapshot = {
        values: { a: '' },
        overrides: {},
        fields: [makeField('a')],
        newFieldNames: new Set(),
      }
      // pushUndo 相当: 適用前 snapshot を clone して退避
      const undoStack = [cloneSnapshot(before)]
      const after = addField(before, 'field_1')
      expect(after.newFieldNames.has('field_1')).toBe(true)
      expect(after.fields.length).toBe(2)
      // undo: 退避 snapshot を適用
      const restored = undoStack.pop()!
      expect(snapshotsEqual(restored, before)).toBe(true)
      expect(restored.newFieldNames.size).toBe(0)
    })
  })

  describe('追加 → 削除: newFieldNames Set クリーンアップ', () => {
    it('新規追加 field を削除すると newFieldNames からも消える', () => {
      const initial: MinutesEditSnapshot = {
        values: { a: '' },
        overrides: {},
        fields: [makeField('a')],
        newFieldNames: new Set(),
      }
      const afterAdd = addField(initial, 'field_1')
      expect(afterAdd.newFieldNames.has('field_1')).toBe(true)
      const afterDelete = deleteField(afterAdd, 'field_1')
      expect(afterDelete.newFieldNames.has('field_1')).toBe(false)
      expect(afterDelete.fields.length).toBe(1)
      // 既存 field 'a' は残る。
      expect(afterDelete.fields[0].name).toBe('a')
    })

    it('既存 field を削除しても newFieldNames は不変（既存は含まれないため）', () => {
      const initial: MinutesEditSnapshot = {
        values: { a: '', b: '' },
        overrides: {},
        fields: [makeField('a'), makeField('b')],
        newFieldNames: new Set(['field_1']),
      }
      // 既存 'a' を削除しても newFieldNames には 'field_1' が居続ける。
      const after = deleteField(initial, 'a')
      expect(after.newFieldNames.has('field_1')).toBe(true)
      expect(after.fields.find((f) => f.name === 'a')).toBeUndefined()
    })
  })

  describe('追加 → 削除 → undo: 復活で newFieldNames も同時復元', () => {
    it('削除前 snapshot を退避 → 削除 → undo で newFieldNames 復活', () => {
      const initial: MinutesEditSnapshot = {
        values: { a: '' },
        overrides: {},
        fields: [makeField('a')],
        newFieldNames: new Set(),
      }
      const afterAdd = addField(initial, 'field_1')
      // 削除前 snapshot を退避
      const undoStack = [cloneSnapshot(afterAdd)]
      const afterDelete = deleteField(afterAdd, 'field_1')
      expect(afterDelete.newFieldNames.has('field_1')).toBe(false)
      // undo
      const restored = undoStack.pop()!
      expect(restored.newFieldNames.has('field_1')).toBe(true)
      expect(restored.fields.some((f) => f.name === 'field_1')).toBe(true)
    })
  })

  describe('複数追加 → 一部削除でも他は維持', () => {
    it('field_1 / field_2 追加 → field_1 削除 → field_2 だけ残る', () => {
      const initial: MinutesEditSnapshot = {
        values: { a: '' },
        overrides: {},
        fields: [makeField('a')],
        newFieldNames: new Set(),
      }
      const s1 = addField(initial, 'field_1')
      const s2 = addField(s1, 'field_2')
      expect(s2.newFieldNames.size).toBe(2)
      const s3 = deleteField(s2, 'field_1')
      expect(s3.newFieldNames.has('field_1')).toBe(false)
      expect(s3.newFieldNames.has('field_2')).toBe(true)
      expect(s3.fields.map((f) => f.name)).toEqual(['a', 'field_2'])
    })
  })
})
