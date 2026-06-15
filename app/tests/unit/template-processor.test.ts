import { describe, it, expect } from 'vitest'
import PizZip from 'pizzip'
import { generatePlaceholderDocx } from '@/lib/ai/template-processor'
import type { TemplateSchema } from '@/lib/ai/schemas/template-schema'

const schema: TemplateSchema = {
  title_position: 'top',
  fields: [
    { name: 'meeting_date', label: '日付', type: 'date', default: 'today', required: true },
    { name: 'attendees', label: '参加者', type: 'list', required: true },
    { name: 'notes', label: '備考', type: 'text', required: false },
  ],
}

describe('generatePlaceholderDocx', () => {
  it('produces a valid OOXML zip with required parts', async () => {
    const buf = await generatePlaceholderDocx(schema, '家族会議')
    expect(buf.byteLength).toBeGreaterThan(0)
    const zip = new PizZip(Buffer.from(buf))
    expect(zip.file('[Content_Types].xml')).toBeTruthy()
    expect(zip.file('word/document.xml')).toBeTruthy()
  })

  it('embeds title and field placeholders', async () => {
    const buf = await generatePlaceholderDocx(schema, '家族会議')
    const zip = new PizZip(Buffer.from(buf))
    const xml = zip.file('word/document.xml')!.asText()
    expect(xml).toContain('家族会議')
    expect(xml).toContain('【日付】')
    expect(xml).toContain('{meeting_date}')
    expect(xml).toContain('【参加者】')
    // list 項目は docxtemplater のループ構文に展開される
    expect(xml).toContain('{#attendees}')
    expect(xml).toContain('{/attendees}')
    expect(xml).toContain('{notes}')
  })

  it('escapes XML-sensitive characters in title and label', async () => {
    const buf = await generatePlaceholderDocx(
      {
        title_position: 'top',
        fields: [{ name: 'foo', label: '<bar & baz>', type: 'text', required: false }],
      },
      'タイトル<test>',
    )
    const zip = new PizZip(Buffer.from(buf))
    const xml = zip.file('word/document.xml')!.asText()
    expect(xml).toContain('タイトル&lt;test&gt;')
    expect(xml).toContain('【&lt;bar &amp; baz&gt;】')
  })
})
