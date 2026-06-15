/**
 * format-agnostic Parser interfaces。
 * 次案件での他フォーマット（Google Sheets 等）対応を見据え、
 * IntermediateFormat は discriminated union で表現する。
 */

export type SupportedFormat = 'docx' | 'pdf' | 'gsheets'

/** Sheets 固有メタ情報（次案件用、Phase 1 では型定義のみ） */
export interface SheetCell {
  value: string | number | boolean | null
  formula: string | null
  formattedValue: string | null
  effectiveBackground: { r: number; g: number; b: number } | null
}

export interface SheetData {
  sheetId: number
  title: string
  rowCount: number
  columnCount: number
  cells: SheetCell[][]
}

export interface MergeRange {
  sheetId: number
  startRowIndex: number
  endRowIndex: number
  startColumnIndex: number
  endColumnIndex: number
}

export interface FormulaCell {
  sheetId: number
  row: number
  column: number
  formula: string
}

export interface ConditionalFormat {
  sheetId: number
  ranges: MergeRange[]
  rule: string
  format: { backgroundColor?: string; textColor?: string }
}

/** Parser 共通中間形式 */
export type IntermediateFormat =
  | { kind: 'html'; html: string }
  | { kind: 'text'; text: string }
  | {
      kind: 'sheets'
      sheets: SheetData[]
      merges: MergeRange[]
      formulas: FormulaCell[]
      conditionalFormats: ConditionalFormat[]
    }

export interface TemplateParser<F extends SupportedFormat = SupportedFormat> {
  format: F
  parse(file: ArrayBuffer | string): Promise<IntermediateFormat>
}
