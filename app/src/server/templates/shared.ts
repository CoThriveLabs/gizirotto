import type { TemplateField } from '@/lib/ai/schemas/template-schema'
import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'

const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10MB（家族議事録テンプレで十分余裕）

// jsonb 格納フィールドの discriminated union（union 全体を表す型）。
// 判別子は bbox の有無（PdfField のみ bbox を持つ）。
type TemplateFieldForDb = TemplateField | PdfField

const CONTENT_TYPE: Record<'docx' | 'pdf' | 'image', string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  image: 'application/pdf',
}

const PROCESSED_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

export { MAX_FILE_BYTES, CONTENT_TYPE, PROCESSED_CONTENT_TYPE }
export type { TemplateFieldForDb }
