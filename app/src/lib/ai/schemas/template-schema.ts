import { z } from 'zod'

/**
 * テンプレ項目スキーマ。
 *
 * - name: snake_case 英数字
 * - label: 日本語表示名
 * - type: date / text / list / table
 * - default: 'today'（date 項目で本日デフォルト）
 * - required: 必須項目フラグ
 */
export const TemplateFieldSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/, 'snake_case (a-z, 0-9, _)')
    .max(40),
  label: z.string().min(1).max(40),
  type: z.enum(['date', 'text', 'list', 'table']),
  default: z.enum(['today']).optional(),
  required: z.boolean().default(false),
})
export type TemplateField = z.infer<typeof TemplateFieldSchema>

export const TemplateSchemaZ = z.object({
  title_position: z.enum(['top', 'header', 'unknown']).default('unknown'),
  fields: z.array(TemplateFieldSchema).min(1).max(20),
})
export type TemplateSchema = z.infer<typeof TemplateSchemaZ>

/**
 * Anthropic API に渡す JSON Schema（手書きで完全制御）。
 *
 * 注意: 2026 年 5 月時点で Anthropic SDK v0.32 系には `response_format: json_schema`
 * 直接対応がないため、本スキーマは **tool definition の `input_schema`** として渡し、
 * `tool_choice: { type: 'tool', name: 'extract_template_structure' }` で
 * 必ず JSON 構造を返させる方式で実装する。
 *
 * 将来 SDK が公式 `output_config.format.type = 'json_schema'`（beta: structured-outputs-2025-11-13）に
 * 対応した時点で `response_format` 経由に切り替え可能（このスキーマはそのまま使い回せる）。
 */
export const templateExtractionJsonSchema = {
  type: 'object' as const,
  required: ['title_position', 'fields'],
  additionalProperties: false,
  properties: {
    title_position: {
      type: 'string',
      enum: ['top', 'header', 'unknown'],
    },
    fields: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: {
        type: 'object',
        required: ['name', 'label', 'type'],
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
          default: { type: 'string', enum: ['today'] },
          required: { type: 'boolean' },
        },
      },
    },
  },
}
