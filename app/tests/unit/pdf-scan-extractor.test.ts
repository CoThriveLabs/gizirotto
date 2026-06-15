/**
 * ScanPdfExtractor unit test。
 *
 * 検証対象: 公開 API の型整合性 + 公開 export の到達性。
 *
 * extractScanPdfLayout の動作確認（merge 経路含む）は
 * `tests/integration/scan-extractor.test.ts` に集約（unit 側は jsdom 環境のため
 * PDF.js / @napi-rs/canvas が読めず、実 PDF 処理は走らせない）。
 *
 * 注意: 知人 PDF 由来内容は test assertion に書かない。
 */
import { describe, it, expect } from 'vitest'
import {
  extractScanPdfLayout,
  type ScanOcrResult,
  type ScanElement,
  type ScanElementType,
  type ExtractScanPdfOptions,
} from '@/lib/parsers/pdf/scan-extractor'

describe('ScanPdfExtractor 公開 API', () => {
  it('extractScanPdfLayout 関数が export されている', () => {
    expect(typeof extractScanPdfLayout).toBe('function')
  })

  it('ExtractScanPdfOptions の最低限のフィールドが受け入れ可能', () => {
    const options: ExtractScanPdfOptions = {
      useBatch: false,
    }
    expect(options.useBatch).toBe(false)
  })

  it('ScanElement の type は 3 値の union', () => {
    const types: ScanElementType[] = ['printed_text', 'handwriting', 'table_cell']
    expect(types).toHaveLength(3)
  })
})

describe('ScanPdfExtractor 型整合性', () => {
  it('ScanOcrResult の最小形状を満たせる', () => {
    const sample: ScanOcrResult = {
      pages: [
        {
          pageIndex: 0,
          pageSize: { widthPt: 595, heightPt: 842 },
          sourceMarkdown: '部署: 開発部\n氏名: 山田 太郎',
          elements: [
            {
              type: 'printed_text',
              text: '部署',
              bbox: { x: 50, y: 100, w: 36, h: 18 },
              confidence: 0.95,
              source: 'mistral+tesseract',
            },
            {
              type: 'handwriting',
              text: '山田',
              bbox: { x: 90, y: 130, w: 50, h: 24 },
              confidence: 0.55,
              source: 'tesseract_only',
            },
            {
              type: 'table_cell',
              text: '日時',
              bbox: { x: 200, y: 100, w: 36, h: 18 },
              confidence: 0.92,
              source: 'mistral+tesseract',
              tableHtml: '<table><tr><th>日時</th><td>2026/05/24</td></tr></table>',
            },
          ],
        },
      ],
    }
    expect(sample.pages).toHaveLength(1)
    expect(sample.pages[0].elements).toHaveLength(3)
    expect(sample.pages[0].elements.map(e => e.type).sort()).toEqual([
      'handwriting',
      'printed_text',
      'table_cell',
    ])
  })
})
