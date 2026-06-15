import { z } from 'zod'

/**
 * PDF レイアウト保持テンプレ用 field スキーマ。
 * 設計書 v1.4.2 §3-7 / 仕様書 v1.6.1 §1-2 完全準拠。
 *
 * 既存 TemplateFieldSchema（src/lib/ai/schemas/template-schema.ts）と
 * 互換性を保ちつつ、bbox / max_chars / font / padding / multiline 等を
 * 追加した PDF レイアウト保持専用スキーマ。
 *
 * 既存 docx fields との関係:
 *   - Phase 2 までの docx テンプレ: TemplateFieldSchema（bbox なし）
 *   - Phase 2.5 以降の PDF テンプレ: PdfFieldSchema（bbox 含む）
 *   - templates.fields は jsonb のまま、アプリケーション側で discriminated union 扱い
 */
export const PdfFieldBboxSchema = z.object({
  page: z.number().int().positive(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
})
export type PdfFieldBbox = z.infer<typeof PdfFieldBboxSchema>

export const PdfFieldFontSchema = z.object({
  family: z.string(),
  size: z.number().positive(),
})
export type PdfFieldFont = z.infer<typeof PdfFieldFontSchema>

export const PdfFieldPaddingSchema = z.object({
  left: z.number().nonnegative(),
  top: z.number().nonnegative(),
  right: z.number().nonnegative(),
  bottom: z.number().nonnegative(),
})
export type PdfFieldPadding = z.infer<typeof PdfFieldPaddingSchema>

export const PdfFieldSchemaZ = z.object({
  name: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/, 'snake_case (a-z, 0-9, _)')
    .max(40),
  label: z.string().min(1).max(40),
  type: z.enum(['date', 'text', 'list', 'table']),
  bbox: PdfFieldBboxSchema,
  max_chars: z.number().int().positive().max(2000),
  font: PdfFieldFontSchema,
  padding: PdfFieldPaddingSchema.default({ left: 4, top: 4, right: 4, bottom: 4 }),
  multiline: z.boolean().default(false),
  align: z.enum(['left', 'center', 'right']).default('left'),
  vertical: z.enum(['top', 'middle', 'bottom']).default('top'),
  writing_mode: z.enum(['horizontal', 'vertical']).default('horizontal'),
  overflow_strategy: z
    .enum(['shrink', 'wrap', 'truncate', 'shrink_then_wrap'])
    .default('shrink_then_wrap'),
  font_size_min: z.number().positive().default(8),
})
export type PdfField = z.infer<typeof PdfFieldSchemaZ>

export const PdfTemplateSchemaZ = z.object({
  fields: z.array(PdfFieldSchemaZ).min(1).max(20),
})
export type PdfTemplateSchema = z.infer<typeof PdfTemplateSchemaZ>

/**
 * Anthropic API に渡す JSON Schema（手書きで完全制御）。
 *
 * 既存 templateExtractionJsonSchema と同パターン（tool_use 強制経路）で実装。
 */
export const pdfTemplateExtractionJsonSchema = {
  type: 'object' as const,
  required: ['fields'],
  additionalProperties: false,
  properties: {
    fields: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: {
        type: 'object',
        required: ['name', 'label', 'type', 'bbox', 'max_chars', 'font'],
        additionalProperties: false,
        properties: {
          name: {
            type: 'string',
            pattern: '^[a-z_][a-z0-9_]*$',
            maxLength: 40,
          },
          label: { type: 'string', minLength: 1, maxLength: 40 },
          type: {
            type: 'string',
            enum: ['date', 'text', 'list', 'table'],
          },
          bbox: {
            type: 'object',
            required: ['page', 'x', 'y', 'w', 'h'],
            additionalProperties: false,
            properties: {
              page: { type: 'integer', minimum: 1 },
              x: { type: 'number' },
              y: { type: 'number' },
              w: { type: 'number' },
              h: { type: 'number' },
            },
          },
          max_chars: { type: 'integer', minimum: 1, maximum: 2000 },
          font: {
            type: 'object',
            required: ['family', 'size'],
            additionalProperties: false,
            properties: {
              family: { type: 'string' },
              size: { type: 'number', exclusiveMinimum: 0 },
            },
          },
          padding: {
            type: 'object',
            additionalProperties: false,
            properties: {
              left: { type: 'number', minimum: 0 },
              top: { type: 'number', minimum: 0 },
              right: { type: 'number', minimum: 0 },
              bottom: { type: 'number', minimum: 0 },
            },
          },
          multiline: { type: 'boolean' },
          align: { type: 'string', enum: ['left', 'center', 'right'] },
          vertical: { type: 'string', enum: ['top', 'middle', 'bottom'] },
          writing_mode: { type: 'string', enum: ['horizontal', 'vertical'] },
          overflow_strategy: {
            type: 'string',
            enum: ['shrink', 'wrap', 'truncate', 'shrink_then_wrap'],
          },
          font_size_min: { type: 'number', exclusiveMinimum: 0 },
        },
      },
    },
  },
}
