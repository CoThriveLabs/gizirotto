import { describe, it, expect } from 'vitest'
import type { TemplateField } from '@/lib/ai/schemas/template-schema'
import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'

/**
 * G1-⑥: templates.ts の fieldsForDb は TemplateField | PdfField の union[] 型。
 * 本テストは両 variant が同一配列型へ代入可能（discriminated union 適合）を
 * コンパイル時 + ランタイムで確認する。判別子は bbox の有無。
 */
type TemplateFieldForDb = TemplateField | PdfField

describe('TemplateFieldForDb union (G1-⑥)', () => {
  it('TemplateField（bbox なし）を代入できる', () => {
    const docxField: TemplateField = {
      name: 'decided_items',
      label: '決定事項',
      type: 'text',
      required: false,
    }
    const arr: TemplateFieldForDb[] = [docxField]
    expect('bbox' in arr[0]).toBe(false)
  })

  it('PdfField（bbox あり）を代入できる', () => {
    const pdfField: PdfField = {
      name: 'next_actions',
      label: '次のアクション',
      type: 'text',
      bbox: { page: 1, x: 0, y: 0, w: 100, h: 20 },
      max_chars: 200,
      font: { family: 'NotoSansJP', size: 10 },
      padding: { left: 4, top: 4, right: 4, bottom: 4 },
      multiline: false,
      align: 'left',
      vertical: 'top',
      writing_mode: 'horizontal',
      overflow_strategy: 'shrink_then_wrap',
      font_size_min: 8,
    }
    const arr: TemplateFieldForDb[] = [pdfField]
    expect('bbox' in arr[0]).toBe(true)
  })

  it('bbox の有無で variant を判別できる', () => {
    const fields: TemplateFieldForDb[] = [
      { name: 'a', label: 'A', type: 'text', required: false },
    ]
    const f = fields[0]
    // 判別子: 'bbox' in f が false なら docx variant
    expect('bbox' in f).toBe(false)
  })
})
