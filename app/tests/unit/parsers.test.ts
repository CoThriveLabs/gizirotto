import { describe, it, expect } from 'vitest'
import { generatePlaceholderDocx } from '@/lib/ai/template-processor'
import { wordParser, pdfParser, getParser } from '@/lib/parsers'

describe('getParser', () => {
  it('returns wordParser for docx', () => {
    expect(getParser('docx')).toBe(wordParser)
  })
  it('returns pdfParser for pdf', () => {
    expect(getParser('pdf')).toBe(pdfParser)
  })
  it('throws for gsheets', () => {
    expect(() => getParser('gsheets')).toThrow()
  })
})

describe('wordParser', () => {
  it('extracts HTML from a generated docx', async () => {
    const docx = await generatePlaceholderDocx(
      {
        title_position: 'top',
        fields: [
          { name: 'meeting_date', label: '日付', type: 'date', required: true },
          { name: 'attendees', label: '参加者', type: 'list', required: true },
        ],
      },
      '家族会議',
    )
    const intermediate = await wordParser.parse(docx)
    expect(intermediate.kind).toBe('html')
    if (intermediate.kind !== 'html') return
    // mammoth は段落を <p> に変換する
    expect(intermediate.html).toContain('家族会議')
    expect(intermediate.html).toContain('【日付】')
    expect(intermediate.html).toContain('【参加者】')
  })

  it('rejects string input', async () => {
    await expect(wordParser.parse('not-a-buffer')).rejects.toThrow(
      'WORD_PARSER_EXPECTS_ARRAY_BUFFER',
    )
  })
})

describe('pdfParser', () => {
  it('rejects string input', async () => {
    await expect(pdfParser.parse('not-a-buffer')).rejects.toThrow(
      'PDF_PARSER_EXPECTS_ARRAY_BUFFER',
    )
  })
})
