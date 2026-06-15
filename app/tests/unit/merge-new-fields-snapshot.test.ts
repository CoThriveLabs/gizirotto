/**
 * 段階 2.5c（設計書 minutes_adjust_editor_renewal_design_2026-06-08.md §9）unit テスト。
 *
 * mergeNewFieldsSnapshot の INSERT / UPDATE / DELETE 判定 + 採番再確定 + 検証を担保:
 *   - INSERT: DB に無く client にあり → 末尾追加 + 採番再確定
 *   - UPDATE: 両方にある name → bbox / label / multiline 上書き、属性は DB 値温存
 *   - DELETE: DB にあるが client に無い → 結果から除外
 *   - 混在: 同一スナップショット内で INSERT / UPDATE / DELETE 同時処理
 *   - 順序保持: DB 既存 newField の出現順 → INSERT の出現順
 *   - 採番再採確定: client 楽観名前が templates / DB 既存と衝突 → field_N
 *   - 件数ガード: FIELDS_MAX(20) 超 → エラー
 *   - bbox 範囲 / label 不正のサーバ side ガード
 *
 * templates `bbox-save.ts mergeFieldsSnapshot` L271-394 と完全同型の判定方式を回帰検証。
 */
import { describe, it, expect } from 'vitest'
import {
  mergeNewFieldsSnapshot,
  type NewFieldSnapshotItem,
} from '@/lib/pdf-output/merge-new-fields-snapshot'
import {
  PdfFieldSchemaZ,
  type PdfField,
} from '@/lib/ai/schemas/pdf-field-schema'
import type { PageMeta } from '@/lib/pdf-output/bbox-coords'

function makePageMeta(): PageMeta {
  return {
    page: 1,
    widthPt: 595,
    heightPt: 842,
    pixelWidth: 595,
    pixelHeight: 842,
  }
}

function makeNewField(name: string, label: string): PdfField {
  return PdfFieldSchemaZ.parse({
    name,
    label,
    type: 'text',
    bbox: { page: 1, x: 50, y: 400, w: 200, h: 24 },
    max_chars: 100,
    font: { family: 'NotoSansJP', size: 10.5 },
  })
}

function makeSnapshot(
  name: string,
  label: string,
  bbox?: Partial<{ x: number; y: number; w: number; h: number; page: number }>,
): NewFieldSnapshotItem {
  return {
    name,
    label,
    bbox: {
      page: bbox?.page ?? 1,
      x: bbox?.x ?? 50,
      y: bbox?.y ?? 400,
      w: bbox?.w ?? 200,
      h: bbox?.h ?? 24,
    },
  }
}

describe('mergeNewFieldsSnapshot', () => {
  describe('INSERT（DB に無く client にあり）', () => {
    it('client 1 件 + DB 空 → 末尾追加', () => {
      const result = mergeNewFieldsSnapshot(
        [],
        [makeSnapshot('field_1', '備考')],
        new Set(['meeting_date', 'topic']),
        [makePageMeta()],
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.newFields.length).toBe(1)
      expect(result.newFields[0].name).toBe('field_1')
      expect(result.newFields[0].label).toBe('備考')
    })

    it('client 複数件 → 出現順で末尾追加', () => {
      const result = mergeNewFieldsSnapshot(
        [],
        [
          makeSnapshot('field_1', 'A'),
          makeSnapshot('field_2', 'B'),
          makeSnapshot('field_3', 'C'),
        ],
        new Set(),
        [makePageMeta()],
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.newFields.map((f) => f.name)).toEqual([
        'field_1',
        'field_2',
        'field_3',
      ])
      expect(result.newFields.map((f) => f.label)).toEqual(['A', 'B', 'C'])
    })

    it('templates fields と name 衝突 → 採番再確定', () => {
      const result = mergeNewFieldsSnapshot(
        [],
        [makeSnapshot('meeting_date', '別議題')],
        new Set(['meeting_date', 'topic']),
        [makePageMeta()],
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      // meeting_date は templates 側 → client は採番再確定（field_1）。
      expect(result.newFields[0].name).toBe('field_1')
      expect(result.newFields[0].label).toBe('別議題')
    })

    it('DB 既存 newField と name 衝突（isNew=true 明示）→ 採番再確定', () => {
      const dbNew = [makeNewField('field_1', '既存')]
      const result = mergeNewFieldsSnapshot(
        dbNew,
        [
          // 既存 UPDATE 用
          makeSnapshot('field_1', '既存更新'),
          // 新規 INSERT で同じ name を楽観指定 → 衝突再採番
          { ...makeSnapshot('field_1', '新規'), isNew: true },
        ],
        new Set(),
        [makePageMeta()],
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.newFields.length).toBe(2)
      expect(result.newFields[0].name).toBe('field_1')
      expect(result.newFields[0].label).toBe('既存更新')
      // 衝突したので field_2 へ再採番される。
      expect(result.newFields[1].name).toBe('field_2')
      expect(result.newFields[1].label).toBe('新規')
    })
  })

  describe('UPDATE（両方にある name）', () => {
    it('bbox / label が client 値で上書きされる', () => {
      const dbNew = [makeNewField('field_1', '旧ラベル')]
      const result = mergeNewFieldsSnapshot(
        dbNew,
        [
          makeSnapshot('field_1', '新ラベル', {
            x: 100,
            y: 200,
            w: 150,
            h: 30,
          }),
        ],
        new Set(),
        [makePageMeta()],
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.newFields[0].name).toBe('field_1')
      expect(result.newFields[0].label).toBe('新ラベル')
      expect(result.newFields[0].bbox).toEqual({
        page: 1,
        x: 100,
        y: 200,
        w: 150,
        h: 30,
      })
    })

    it('属性（type / max_chars / font / padding）は DB 値温存', () => {
      const dbNew = [
        PdfFieldSchemaZ.parse({
          name: 'field_1',
          label: '旧',
          type: 'text',
          bbox: { page: 1, x: 50, y: 400, w: 200, h: 24 },
          max_chars: 500,
          font: { family: 'CustomFont', size: 14 },
          padding: { left: 10, top: 10, right: 10, bottom: 10 },
        }),
      ]
      const result = mergeNewFieldsSnapshot(
        dbNew,
        [makeSnapshot('field_1', '新')],
        new Set(),
        [makePageMeta()],
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.newFields[0].max_chars).toBe(500)
      expect(result.newFields[0].font.family).toBe('CustomFont')
      expect(result.newFields[0].font.size).toBe(14)
      expect(result.newFields[0].padding).toEqual({
        left: 10,
        top: 10,
        right: 10,
        bottom: 10,
      })
    })
  })

  describe('DELETE（DB にあるが client に無い）', () => {
    it('DB 既存 newField が client snapshot に無い → 結果から除外', () => {
      const dbNew = [
        makeNewField('field_1', 'A'),
        makeNewField('field_2', 'B'),
      ]
      const result = mergeNewFieldsSnapshot(
        dbNew,
        [makeSnapshot('field_1', 'A')], // field_2 を含まない
        new Set(),
        [makePageMeta()],
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.newFields.length).toBe(1)
      expect(result.newFields[0].name).toBe('field_1')
    })

    it('client snapshot が空 → 全削除（DB 既存全件除外）', () => {
      const dbNew = [
        makeNewField('field_1', 'A'),
        makeNewField('field_2', 'B'),
      ]
      const result = mergeNewFieldsSnapshot(dbNew, [], new Set(), [
        makePageMeta(),
      ])
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.newFields.length).toBe(0)
    })
  })

  describe('混在（INSERT / UPDATE / DELETE 同時）', () => {
    it('DB= [a, b, c] + client= [a更新, c, d 新規] → 結果 [a更新, c, d]', () => {
      const dbNew = [
        makeNewField('field_1', 'A'),
        makeNewField('field_2', 'B'),
        makeNewField('field_3', 'C'),
      ]
      const result = mergeNewFieldsSnapshot(
        dbNew,
        [
          makeSnapshot('field_1', 'A更新'),
          makeSnapshot('field_3', 'C'),
          { ...makeSnapshot('field_4', 'D'), isNew: true },
        ],
        new Set(),
        [makePageMeta()],
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.newFields.map((f) => f.name)).toEqual([
        'field_1',
        'field_3',
        'field_4',
      ])
      expect(result.newFields[0].label).toBe('A更新')
      expect(result.newFields[2].label).toBe('D')
    })
  })

  describe('順序保持', () => {
    it('DB 既存の出現順 → INSERT の出現順で末尾', () => {
      const dbNew = [
        makeNewField('field_5', 'E'),
        makeNewField('field_3', 'C'),
      ]
      const result = mergeNewFieldsSnapshot(
        dbNew,
        [
          makeSnapshot('field_3', 'C'),
          makeSnapshot('field_5', 'E'),
          { ...makeSnapshot('field_7', 'G'), isNew: true },
        ],
        new Set(),
        [makePageMeta()],
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.newFields.map((f) => f.name)).toEqual([
        // DB 出現順は [field_5, field_3] のまま
        'field_5',
        'field_3',
        // INSERT は末尾
        'field_7',
      ])
    })
  })

  describe('名前形式不正の防御', () => {
    it('snake_case 外（大文字含む）→ 採番再確定', () => {
      const result = mergeNewFieldsSnapshot(
        [],
        [makeSnapshot('NotSnake', 'A')],
        new Set(),
        [makePageMeta()],
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.newFields[0].name).toBe('field_1')
    })

    it('41 文字超 → 採番再確定', () => {
      const result = mergeNewFieldsSnapshot(
        [],
        [makeSnapshot('a'.repeat(41), 'A')],
        new Set(),
        [makePageMeta()],
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.newFields[0].name).toBe('field_1')
    })
  })

  describe('件数上限', () => {
    it('20 件超 INSERT → FIELD_COUNT_OUT_OF_RANGE', () => {
      const items: NewFieldSnapshotItem[] = []
      for (let i = 1; i <= 21; i++) {
        items.push(makeSnapshot(`field_${i}`, `L${i}`))
      }
      const result = mergeNewFieldsSnapshot([], items, new Set(), [
        makePageMeta(),
      ])
      expect(result.ok).toBe(false)
      if (result.ok) return
      // 採番再確定で 21 件目が field_21 に振られて検証段でエラーになる経路もありうるが、
      // 結果として「件数オーバー」が検知されればよい（NAME_GEN_FAILED or FIELD_COUNT_OUT_OF_RANGE）。
      expect(['FIELD_COUNT_OUT_OF_RANGE', 'NAME_GEN_FAILED']).toContain(
        result.error,
      )
    })

    it('ちょうど 20 件 → OK', () => {
      const items: NewFieldSnapshotItem[] = []
      for (let i = 1; i <= 20; i++) {
        items.push(makeSnapshot(`field_${i}`, `L${i}`))
      }
      const result = mergeNewFieldsSnapshot([], items, new Set(), [
        makePageMeta(),
      ])
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.newFields.length).toBe(20)
    })
  })

  describe('検証エラー', () => {
    it('label 空文字 → INVALID_LABEL', () => {
      const result = mergeNewFieldsSnapshot(
        [],
        [makeSnapshot('field_1', '')],
        new Set(),
        [makePageMeta()],
      )
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toBe('INVALID_LABEL')
    })

    it('label 41 文字 → INVALID_LABEL', () => {
      const result = mergeNewFieldsSnapshot(
        [],
        [makeSnapshot('field_1', 'a'.repeat(41))],
        new Set(),
        [makePageMeta()],
      )
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toBe('INVALID_LABEL')
    })

    it('bbox 範囲外（page 外）→ BBOX_OUT_OF_RANGE', () => {
      const result = mergeNewFieldsSnapshot(
        [],
        [makeSnapshot('field_1', 'A', { x: 100, y: 100, w: 2000, h: 24 })],
        new Set(),
        [makePageMeta()],
      )
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toBe('BBOX_OUT_OF_RANGE')
    })

    it('未登録 page → PAGE_NOT_FOUND', () => {
      const result = mergeNewFieldsSnapshot(
        [],
        [makeSnapshot('field_1', 'A', { page: 2 })],
        new Set(),
        [makePageMeta()],
      )
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toBe('PAGE_NOT_FOUND')
    })
  })

  describe('multiline オプション', () => {
    it('client の multiline 指定が反映される', () => {
      const result = mergeNewFieldsSnapshot(
        [],
        [{ ...makeSnapshot('field_1', '備考'), multiline: true }],
        new Set(),
        [makePageMeta()],
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.newFields[0].multiline).toBe(true)
    })

    it('UPDATE で multiline 切替', () => {
      const dbNew = [
        PdfFieldSchemaZ.parse({
          name: 'field_1',
          label: '旧',
          type: 'text',
          bbox: { page: 1, x: 50, y: 400, w: 200, h: 24 },
          max_chars: 100,
          font: { family: 'NotoSansJP', size: 10.5 },
          multiline: false,
        }),
      ]
      const result = mergeNewFieldsSnapshot(
        dbNew,
        [{ ...makeSnapshot('field_1', '新'), multiline: true }],
        new Set(),
        [makePageMeta()],
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.newFields[0].multiline).toBe(true)
    })
  })
})
