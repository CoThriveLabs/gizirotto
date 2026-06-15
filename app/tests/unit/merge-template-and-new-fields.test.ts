import { describe, it, expect } from 'vitest'
import {
  mergeTemplateAndNewFields,
  parseNewFields,
} from '@/lib/pdf-output/merge-template-and-new-fields'
import { PdfFieldSchemaZ, type PdfField } from '@/lib/ai/schemas/pdf-field-schema'

/**
 * 段階 2.5a（設計書 minutes_adjust_editor_renewal_design_2026-06-08.md §9）unit テスト。
 *
 * mergeTemplateAndNewFields の振る舞いを担保:
 *   - 空配列 / null / undefined: templates fields をそのまま返す（不変・後方互換）
 *   - 衝突なし: templates → newFields 末尾追加（順序維持）
 *   - 名前衝突: templates 優先 / newFields 側を `field_N` 採番再確定
 *   - 不正な name（snake_case 外）: 採番再確定
 *   - 破損要素: スキップ
 *   - 上限 20: 超過分は捨てる（防御）
 *
 * parseNewFields は破損 jsonb 値の正規化を担保:
 *   - null / 非配列: 空配列
 *   - 配列内の壊れた要素: スキップ
 */

function tplField(name: string, label = name): PdfField {
  return PdfFieldSchemaZ.parse({
    name,
    label,
    type: 'text',
    bbox: { page: 1, x: 100, y: 100, w: 200, h: 24 },
    max_chars: 200,
    font: { family: 'NotoSansJP', size: 11 },
  })
}

function newField(name: string, label = name): PdfField {
  return PdfFieldSchemaZ.parse({
    name,
    label,
    type: 'text',
    bbox: { page: 1, x: 50, y: 400, w: 200, h: 24 },
    max_chars: 100,
    font: { family: 'NotoSansJP', size: 10.5 },
  })
}

describe('mergeTemplateAndNewFields', () => {
  describe('newFields 空ケース（後方互換）', () => {
    it('newFields = undefined → templates をそのまま返す', () => {
      const tpl = [tplField('meeting_date'), tplField('topic')]
      const result = mergeTemplateAndNewFields(tpl, undefined)
      expect(result).toEqual(tpl)
      // 参照同一性は保証しない（新規配列）が、要素の同型を担保。
      expect(result).not.toBe(tpl)
    })

    it('newFields = null → templates をそのまま返す', () => {
      const tpl = [tplField('meeting_date')]
      const result = mergeTemplateAndNewFields(tpl, null)
      expect(result.map((f) => f.name)).toEqual(['meeting_date'])
    })

    it('newFields = [] → templates をそのまま返す', () => {
      const tpl = [tplField('meeting_date'), tplField('topic')]
      const result = mergeTemplateAndNewFields(tpl, [])
      expect(result.map((f) => f.name)).toEqual(['meeting_date', 'topic'])
    })

    it('templates も新規も空 → 空配列', () => {
      expect(mergeTemplateAndNewFields([], [])).toEqual([])
      expect(mergeTemplateAndNewFields([], null)).toEqual([])
    })
  })

  describe('衝突なしの末尾追加', () => {
    it('templates → newFields 順で並ぶ', () => {
      const tpl = [tplField('meeting_date'), tplField('topic')]
      const nf = [newField('memo_a'), newField('memo_b')]
      const result = mergeTemplateAndNewFields(tpl, nf)
      expect(result.map((f) => f.name)).toEqual([
        'meeting_date',
        'topic',
        'memo_a',
        'memo_b',
      ])
    })

    it('newFields の bbox / font はそのまま保持される', () => {
      const tpl = [tplField('topic')]
      const nf = [newField('memo_a')]
      const result = mergeTemplateAndNewFields(tpl, nf)
      expect(result[1].bbox).toEqual({ page: 1, x: 50, y: 400, w: 200, h: 24 })
      expect(result[1].font.family).toBe('NotoSansJP')
    })
  })

  describe('name 衝突時 templates 優先・newFields 採番再確定', () => {
    it('newFields の name が templates と衝突 → field_N 採番', () => {
      const tpl = [tplField('meeting_date'), tplField('topic')]
      const nf = [newField('topic', '別議題')] // templates と衝突
      const result = mergeTemplateAndNewFields(tpl, nf)
      // templates 側は不変。
      expect(result[0].name).toBe('meeting_date')
      expect(result[1].name).toBe('topic')
      expect(result[1].label).toBe('topic') // templates 側 label 維持
      // newFields 側は採番再確定（field_1 が最小空き）。
      expect(result[2].name).toBe('field_1')
      expect(result[2].label).toBe('別議題')
    })

    it('templates に field_1 が既にある → field_2 が採番される', () => {
      const tpl = [tplField('field_1'), tplField('topic')]
      const nf = [newField('topic')] // 衝突
      const result = mergeTemplateAndNewFields(tpl, nf)
      expect(result[2].name).toBe('field_2')
    })

    it('newFields 同士の衝突も再採番される（複数件）', () => {
      const tpl = [tplField('topic')]
      const nf = [
        newField('topic', 'a'), // 衝突 → 採番
        newField('topic', 'b'), // 同じく衝突 → 次の空き
      ]
      const result = mergeTemplateAndNewFields(tpl, nf)
      expect(result.map((f) => f.name)).toEqual(['topic', 'field_1', 'field_2'])
      expect(result[1].label).toBe('a')
      expect(result[2].label).toBe('b')
    })
  })

  describe('name 形式不正の防御', () => {
    it('snake_case 外（大文字含む）→ 採番再確定', () => {
      const tpl = [tplField('topic')]
      // PdfFieldSchemaZ では弾かれるが、parseNewFields は寛容に通す前提で
      // raw 型を作って渡す（DB 由来の旧データを想定）。
      const broken = {
        ...newField('memo_a'),
        name: 'NotSnakeCase',
      } as PdfField
      const result = mergeTemplateAndNewFields(tpl, [broken])
      expect(result[1].name).toBe('field_1')
    })

    it('41 文字超 → 採番再確定', () => {
      const tpl = [tplField('topic')]
      const broken = {
        ...newField('memo_a'),
        name: 'a'.repeat(41),
      } as PdfField
      const result = mergeTemplateAndNewFields(tpl, [broken])
      expect(result[1].name).toBe('field_1')
    })
  })

  describe('上限 / 防御', () => {
    it('templates 既存 20 件 + newFields 1 件追加でも採番できる（field_N で 21 件目）', () => {
      // 20 件中 field_1〜field_20 が無い場合は field_1 が使える。
      const tpl: PdfField[] = []
      for (let i = 1; i <= 20; i++) tpl.push(tplField(`col_${i}`))
      const nf = [newField('col_1')] // 衝突 → field_1
      const result = mergeTemplateAndNewFields(tpl, nf)
      expect(result.length).toBe(21)
      expect(result[20].name).toBe('field_1')
    })

    it('全 field_N が埋まり採番不能なら以降を捨てる', () => {
      const tpl: PdfField[] = []
      for (let i = 1; i <= 20; i++) tpl.push(tplField(`field_${i}`))
      const nf = [newField('field_1'), newField('field_2')]
      const result = mergeTemplateAndNewFields(tpl, nf)
      // field_21 まで使えるので 1 件は採番可能。2 件目は break で捨てる。
      expect(result.length).toBe(21)
      expect(result[20].name).toBe('field_21')
    })
  })
})

describe('parseNewFields', () => {
  it('null → []', () => {
    expect(parseNewFields(null)).toEqual([])
  })
  it('undefined → []', () => {
    expect(parseNewFields(undefined)).toEqual([])
  })
  it('文字列 → []', () => {
    expect(parseNewFields('not array')).toEqual([])
  })
  it('配列の壊れた要素はスキップ', () => {
    const raw = [
      newField('memo_a'),
      null,
      { name: 'no_bbox' }, // bbox 無し
      { bbox: { page: 1 } }, // name 無し
      newField('memo_b'),
    ]
    const result = parseNewFields(raw)
    expect(result.map((f) => f.name)).toEqual(['memo_a', 'memo_b'])
  })
  it('正常な PdfField[] はそのまま通る', () => {
    const raw = [newField('memo_a'), newField('memo_b')]
    const result = parseNewFields(raw)
    expect(result.length).toBe(2)
    expect(result.map((f) => f.name)).toEqual(['memo_a', 'memo_b'])
  })
})

describe('saveMinuteAdjust zod schema 互換性（PdfFieldSchemaZ）', () => {
  it('PdfFieldSchemaZ で newFields の各要素を parse できる', () => {
    const nf = newField('memo_a')
    const parsed = PdfFieldSchemaZ.safeParse(nf)
    expect(parsed.success).toBe(true)
  })

  it('snake_case 外の name は zod で弾かれる', () => {
    const broken = { ...newField('memo_a'), name: 'NotSnake' }
    const parsed = PdfFieldSchemaZ.safeParse(broken)
    expect(parsed.success).toBe(false)
  })
})
