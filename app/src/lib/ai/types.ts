/**
 * 議事録生成系の共通型。設計書付録 B §B-2〜B-7 準拠。
 * Phase 1 では Phase 3 以降で参照されるため型のみ先行定義。
 */

export interface TemplateField {
  name: string
  label: string
  type: 'date' | 'text' | 'list' | 'table'
  default?: 'today'
  required: boolean
}

export interface TemplateSchema {
  title_position: 'top' | 'header' | 'unknown'
  fields: TemplateField[]
}

export type ToneTemplateId = 1 | 2 | 3 | 4 | 5

export interface ToneInstruction {
  templateId: ToneTemplateId
  customText: string | null
}

export type GeneratedJson = Record<string, string | string[]>

export interface PastMinutesExample {
  meetingDate: string
  contentJson: GeneratedJson
  similarity?: number
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}
