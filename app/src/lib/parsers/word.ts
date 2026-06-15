import mammoth from 'mammoth'
import type { TemplateParser, IntermediateFormat } from './types'

/**
 * Word (.docx) パーサー。
 * mammoth で HTML 化し、構造抽出（Claude）に渡す中間形式とする。
 */
export const wordParser: TemplateParser<'docx'> = {
  format: 'docx',
  async parse(file: ArrayBuffer | string): Promise<IntermediateFormat> {
    if (typeof file === 'string') {
      throw new Error('WORD_PARSER_EXPECTS_ARRAY_BUFFER')
    }
    // mammoth の Node API は Buffer を受ける。ArrayBuffer から変換。
    const buffer = Buffer.from(file)
    const result = await mammoth.convertToHtml({ buffer })
    return { kind: 'html', html: result.value }
  },
}
