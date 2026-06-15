/**
 * FieldSemanticExtractor unit test。
 *
 * 検証対象:
 *   - fake Anthropic client で tool_use 経路の組み立てと zod parse
 *   - watermark 除外が入力構築前に作用すること
 *   - スキャン経路 (scanResult) / テキスト経路 (textResult) / 両方混在 OK
 *   - 入力空ならエラー
 *
 * 注意: Claude 呼出は座標を変更せず意味判定のみ。本テストは
 * 「呼出時の入力プロンプトに 3 入力（markdown / tablesHtml / bboxWords）が含まれる」
 * ことを fake client の引数キャプチャで確認する。
 */
import { describe, it, expect } from 'vitest'
import {
  extractFieldsBySemantic,
  type PdfFieldExtractorClient,
} from '@/lib/parsers/pdf/field-semantic'
import type { TextExtractionResult } from '@/lib/parsers/pdf/text-extractor'
import type { ScanOcrResult } from '@/lib/parsers/pdf/scan-extractor'
import type { WatermarkRegion } from '@/lib/parsers/pdf/editor-watermark-filter'
import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'

process.env.ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-test-model'

function fakeClientReturning(fields: PdfField[]): {
  client: PdfFieldExtractorClient
  capturedParams: { value: unknown }
} {
  const captured: { value: unknown } = { value: undefined }
  const client: PdfFieldExtractorClient = {
    messages: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async create(...args: any[]) {
        captured.value = args[0]
        return {
          content: [
            {
              type: 'tool_use',
              name: 'extract_pdf_template_structure',
              input: { fields },
            },
          ],
        }
      },
    } as unknown as PdfFieldExtractorClient['messages'],
  }
  return { client, capturedParams: captured }
}

const SAMPLE_FIELD: PdfField = {
  name: 'busho',
  label: '部署',
  type: 'text',
  bbox: { page: 1, x: 60, y: 100, w: 200, h: 24 },
  max_chars: 40,
  font: { family: 'Noto Sans JP', size: 12 },
  padding: { left: 4, top: 4, right: 4, bottom: 4 },
  multiline: false,
  align: 'left',
  vertical: 'top',
  writing_mode: 'horizontal',
  overflow_strategy: 'shrink_then_wrap',
  font_size_min: 8,
}

describe('extractFieldsBySemantic - 基本動作', () => {
  it('scanResult のみで fields 抽出可能', async () => {
    const scan: ScanOcrResult = {
      pages: [
        {
          pageIndex: 0,
          pageSize: { widthPt: 595, heightPt: 842 },
          sourceMarkdown: '部署: 開発部',
          elements: [
            {
              type: 'printed_text',
              text: '部署',
              bbox: { x: 60, y: 100, w: 36, h: 18 },
              confidence: 0.95,
              source: 'mistral+tesseract',
            },
          ],
        },
      ],
    }
    const { client, capturedParams } = fakeClientReturning([SAMPLE_FIELD])
    const fields = await extractFieldsBySemantic(
      { scanResult: scan, inputPathType: 'B' },
      { client },
    )
    expect(fields).toHaveLength(1)
    expect(fields[0].name).toBe('busho')
    // user message に Mistral markdown / Tesseract bbox が含まれること
    const params = capturedParams.value as { messages: Array<{ content: string }> }
    expect(params.messages[0].content).toContain('部署: 開発部')
    expect(params.messages[0].content).toContain('Tesseract.js bbox 付き word')
  })

  it('textResult のみで fields 抽出可能（テキスト PDF 経路）', async () => {
    const text: TextExtractionResult = {
      items: [
        {
          page: 1,
          text: '部署',
          bbox: { x: 60, y: 100, w: 36, h: 18 },
          fontName: 'NotoSansJP',
          fontSize: 12,
        },
      ],
      pageSizes: [{ page: 1, width: 595, height: 842 }],
    }
    const { client, capturedParams } = fakeClientReturning([SAMPLE_FIELD])
    const fields = await extractFieldsBySemantic(
      { textResult: text, inputPathType: 'A' },
      { client },
    )
    expect(fields).toHaveLength(1)
    const params = capturedParams.value as { messages: Array<{ content: string }> }
    // テキスト PDF 経路では classification = text
    expect(params.messages[0].content).toContain('テキスト PDF')
    expect(params.messages[0].content).toContain('パス A')
  })

  it('textResult + scanResult 両方与えると 3 入力すべて含む', async () => {
    const text: TextExtractionResult = {
      items: [
        {
          page: 1,
          text: '日時',
          bbox: { x: 60, y: 50, w: 36, h: 18 },
          fontName: 'F',
          fontSize: 12,
        },
      ],
      pageSizes: [{ page: 1, width: 595, height: 842 }],
    }
    const scan: ScanOcrResult = {
      pages: [
        {
          pageIndex: 0,
          pageSize: { widthPt: 595, heightPt: 842 },
          sourceMarkdown: '# 議事録',
          elements: [
            {
              type: 'table_cell',
              text: '部署',
              bbox: { x: 60, y: 100, w: 36, h: 18 },
              confidence: 0.95,
              source: 'mistral+tesseract',
              tableHtml: '<table><tr><th>部署</th></tr></table>',
            },
          ],
        },
      ],
    }
    const { client, capturedParams } = fakeClientReturning([SAMPLE_FIELD])
    await extractFieldsBySemantic(
      { textResult: text, scanResult: scan, inputPathType: 'A' },
      { client },
    )
    const content = (capturedParams.value as { messages: Array<{ content: string }> })
      .messages[0].content
    expect(content).toContain('# 議事録') // markdown
    expect(content).toContain('<table>') // tables HTML
    expect(content).toContain('"日時"') // bboxWords (from text)
    expect(content).toContain('"部署"') // bboxWords (from scan)
  })

  it('入力が両方とも空ならエラー', async () => {
    const { client } = fakeClientReturning([SAMPLE_FIELD])
    await expect(
      extractFieldsBySemantic({ inputPathType: 'A' }, { client }),
    ).rejects.toThrow('FIELD_SEMANTIC_INPUT_EMPTY')
  })
})

describe('extractFieldsBySemantic - watermark 除外', () => {
  it('watermarkRegions に該当する scanResult 要素は Claude 入力に渡らない', async () => {
    const scan: ScanOcrResult = {
      pages: [
        {
          pageIndex: 0,
          pageSize: { widthPt: 595, heightPt: 842 },
          sourceMarkdown: '',
          elements: [
            {
              type: 'printed_text',
              text: '試用版',
              bbox: { x: 480, y: 10, w: 60, h: 16 },
              confidence: 0.97,
              source: 'tesseract_only',
            },
            {
              type: 'printed_text',
              text: '部署',
              bbox: { x: 60, y: 100, w: 36, h: 18 },
              confidence: 0.95,
              source: 'mistral+tesseract',
            },
          ],
        },
      ],
    }
    const regions: WatermarkRegion[] = [
      {
        page: 1,
        bbox: { x: 480, y: 10, w: 60, h: 16 },
        reason: 'keyword_match',
        matchedKeyword: '試用版',
      },
    ]
    const { client, capturedParams } = fakeClientReturning([SAMPLE_FIELD])
    await extractFieldsBySemantic(
      { scanResult: scan, watermarkRegions: regions, inputPathType: 'B' },
      { client },
    )
    const content = (capturedParams.value as { messages: Array<{ content: string }> })
      .messages[0].content
    // 試用版は除外されて Claude 入力に出ない、部署のみ残る
    expect(content).not.toContain('"試用版"')
    expect(content).toContain('"部署"')
  })
})

describe('extractFieldsBySemantic - tool_use 強制と zod parse', () => {
  it('tool_use ブロックが無いとエラー', async () => {
    const client: PdfFieldExtractorClient = {
      messages: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async create(..._args: any[]) {
          return { content: [{ type: 'text', text: 'no tool use' }] }
        },
      } as unknown as PdfFieldExtractorClient['messages'],
    }
    const scan: ScanOcrResult = {
      pages: [
        {
          pageIndex: 0,
          pageSize: { widthPt: 595, heightPt: 842 },
          sourceMarkdown: '',
          elements: [],
        },
      ],
    }
    await expect(
      extractFieldsBySemantic({ scanResult: scan, inputPathType: 'A' }, { client }),
    ).rejects.toThrow('NO_TOOL_USE_BLOCK')
  })

  it('zod スキーマに違反する field（name が大文字含む）はエラー', async () => {
    const invalidField = { ...SAMPLE_FIELD, name: 'INVALID' } as unknown as PdfField
    const { client } = fakeClientReturning([invalidField])
    const scan: ScanOcrResult = {
      pages: [
        {
          pageIndex: 0,
          pageSize: { widthPt: 595, heightPt: 842 },
          sourceMarkdown: '',
          elements: [],
        },
      ],
    }
    await expect(
      extractFieldsBySemantic({ scanResult: scan, inputPathType: 'A' }, { client }),
    ).rejects.toThrow()
  })
})
