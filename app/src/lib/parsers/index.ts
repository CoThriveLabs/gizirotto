import { wordParser } from './word'
import { pdfParser } from './pdf'
import type { SupportedFormat, TemplateParser } from './types'

export type { SupportedFormat, TemplateParser, IntermediateFormat } from './types'
export { wordParser, pdfParser }

/**
 * Parser ファクトリ。
 * 'gsheets' は現状未対応。
 */
export function getParser(format: SupportedFormat): TemplateParser<SupportedFormat> {
  switch (format) {
    case 'docx':
      return wordParser as TemplateParser<SupportedFormat>
    case 'pdf':
      return pdfParser as TemplateParser<SupportedFormat>
    case 'gsheets':
      throw new Error('SheetsParser is not implemented in minutes-app')
    default: {
      // exhaustiveness check
      const _exhaustive: never = format
      throw new Error(`Unknown format: ${String(_exhaustive)}`)
    }
  }
}
