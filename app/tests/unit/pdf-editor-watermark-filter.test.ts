/**
 * PdfEditorWatermarkFilter unit test。
 *
 * 検証対象:
 *   - detectEditorWatermarks: rawText / ocrResult 両系統でキーワード検出
 *   - 位置パターン強化（corner overlay）
 *   - detectEditorWatermarksInMarkdown: markdown のみ経路
 *   - filterOutWatermarkedRawText / filterOutWatermarkedScanElements: 除外動作
 *
 * 注意: PDF ファイル本体への加工は一切ない（filter 関数群は WatermarkRegion / 除外済
 * コレクションを返すのみ）。本テストでも PDF ファイル変更系の動作は検証しない。
 */
import { describe, it, expect } from 'vitest'
import {
  detectEditorWatermarks,
  detectEditorWatermarksInMarkdown,
  filterOutWatermarkedRawText,
  filterOutWatermarkedScanElements,
  EDITOR_WATERMARK_KEYWORDS,
} from '@/lib/parsers/pdf/editor-watermark-filter'
import type { RawTextItem, PdfPageSize } from '@/lib/parsers/pdf/pdf-types'
import type { ScanOcrResult } from '@/lib/parsers/pdf/scan-extractor'

const PAGE_SIZES: PdfPageSize[] = [{ page: 1, width: 595, height: 842 }]

describe('EDITOR_WATERMARK_KEYWORDS 辞書', () => {
  it('初期辞書 14 個', () => {
    expect(EDITOR_WATERMARK_KEYWORDS.length).toBe(14)
  })
  it('主要ベンダー名 / 試用表示が含まれる', () => {
    expect(EDITOR_WATERMARK_KEYWORDS).toContain('試用版')
    expect(EDITOR_WATERMARK_KEYWORDS).toContain('PDFelement')
    expect(EDITOR_WATERMARK_KEYWORDS).toContain('Wondershare')
    expect(EDITOR_WATERMARK_KEYWORDS).toContain('Trial')
  })
})

describe('detectEditorWatermarks - rawText (テキスト PDF 経路)', () => {
  it('キーワード一致した RawTextItem を WatermarkRegion として返す', () => {
    const rawText: RawTextItem[] = [
      {
        page: 1,
        text: '試用版 PDFelement',
        bbox: { x: 480, y: 10, w: 100, h: 16 },
        fontName: 'Helvetica',
        fontSize: 12,
      },
      {
        page: 1,
        text: '部署',
        bbox: { x: 60, y: 100, w: 36, h: 18 },
        fontName: 'NotoSansJP',
        fontSize: 12,
      },
    ]
    const regions = detectEditorWatermarks({ rawText, pageSizes: PAGE_SIZES })
    expect(regions).toHaveLength(1)
    expect(regions[0].page).toBe(1)
    expect(regions[0].matchedKeyword).toBe('試用版')
    // 右上 corner（cx=530 > 357=595*0.6, cy=18 < 84.2=842*0.1）= 位置強化される
    expect(regions[0].reason).toBe('position_corner_overlay')
  })

  it('corner overlay 位置外のキーワード一致は keyword_match のまま', () => {
    const rawText: RawTextItem[] = [
      {
        page: 1,
        text: 'PDFelement Trial',
        // ページ中央付近 = corner ではない
        bbox: { x: 200, y: 400, w: 150, h: 16 },
        fontName: 'Helvetica',
        fontSize: 12,
      },
    ]
    const regions = detectEditorWatermarks({ rawText, pageSizes: PAGE_SIZES })
    expect(regions).toHaveLength(1)
    expect(regions[0].reason).toBe('keyword_match')
  })

  it('rawText が空 / 一致なしなら空配列', () => {
    expect(detectEditorWatermarks({ pageSizes: PAGE_SIZES })).toEqual([])
    expect(
      detectEditorWatermarks({
        rawText: [
          {
            page: 1,
            text: '部署',
            bbox: { x: 60, y: 100, w: 36, h: 18 },
            fontName: 'NotoSansJP',
            fontSize: 12,
          },
        ],
        pageSizes: PAGE_SIZES,
      }),
    ).toEqual([])
  })
})

describe('detectEditorWatermarks - ocrResult (スキャン PDF 経路)', () => {
  it('ScanOcrResult.elements からキーワード一致を検出', () => {
    const ocr: ScanOcrResult = {
      pages: [
        {
          pageIndex: 0,
          pageSize: { widthPt: 595, heightPt: 842 },
          sourceMarkdown: '',
          elements: [
            {
              type: 'printed_text',
              text: 'Wondershare PDFelement',
              bbox: { x: 480, y: 10, w: 100, h: 16 },
              confidence: 0.97,
              source: 'tesseract_only',
            },
            {
              type: 'printed_text',
              text: '氏名',
              bbox: { x: 50, y: 100, w: 36, h: 18 },
              confidence: 0.95,
              source: 'mistral+tesseract',
            },
          ],
        },
      ],
    }
    const regions = detectEditorWatermarks({ ocrResult: ocr, pageSizes: PAGE_SIZES })
    expect(regions).toHaveLength(1)
    expect(regions[0].page).toBe(1) // 0-based → 1-based
    // 辞書順 (PDFelement が Wondershare より先) で最初にヒットしたものを返す
    expect(regions[0].matchedKeyword).toBe('PDFelement')
    expect(regions[0].reason).toBe('position_corner_overlay')
  })
})

describe('detectEditorWatermarksInMarkdown', () => {
  it('markdown 中のキーワード位置を検出（startIndex 含む）', () => {
    const md = '試用版\nPDFelement\n\n# 議事録\n\n部署: 開発部'
    const hits = detectEditorWatermarksInMarkdown(md)
    expect(hits.length).toBeGreaterThanOrEqual(2)
    const keywords = hits.map(h => h.keyword)
    expect(keywords).toContain('試用版')
    expect(keywords).toContain('PDFelement')
    // 試用版 は冒頭 startIndex=0
    const trialHit = hits.find(h => h.keyword === '試用版')
    expect(trialHit?.index).toBe(0)
  })

  it('複数出現は全て取得', () => {
    const md = 'Trial xxx Trial yyy'
    const hits = detectEditorWatermarksInMarkdown(md)
    const trialHits = hits.filter(h => h.keyword === 'Trial')
    expect(trialHits.length).toBe(2)
    expect(trialHits[0].index).toBe(0)
    expect(trialHits[1].index).toBe(10)
  })

  it('該当なしは空配列', () => {
    expect(detectEditorWatermarksInMarkdown('普通の議事録テキスト')).toEqual([])
  })
})

describe('filterOutWatermarkedRawText / filterOutWatermarkedScanElements', () => {
  it('region と一致した RawTextItem を除外（座標完全一致のみ）', () => {
    const items: RawTextItem[] = [
      {
        page: 1,
        text: '試用版',
        bbox: { x: 480, y: 10, w: 60, h: 16 },
        fontName: 'F',
        fontSize: 12,
      },
      {
        page: 1,
        text: '部署',
        bbox: { x: 60, y: 100, w: 36, h: 18 },
        fontName: 'F',
        fontSize: 12,
      },
    ]
    const regions = detectEditorWatermarks({ rawText: items, pageSizes: PAGE_SIZES })
    const filtered = filterOutWatermarkedRawText(items, regions)
    expect(filtered).toHaveLength(1)
    expect(filtered[0].text).toBe('部署')
  })

  it('region が空ならそのまま返す', () => {
    const items: RawTextItem[] = [
      {
        page: 1,
        text: '部署',
        bbox: { x: 60, y: 100, w: 36, h: 18 },
        fontName: 'F',
        fontSize: 12,
      },
    ]
    expect(filterOutWatermarkedRawText(items, [])).toBe(items)
  })

  it('ScanOcrResult.elements から region と一致した要素を除外', () => {
    const ocr: ScanOcrResult = {
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
              text: '氏名',
              bbox: { x: 50, y: 100, w: 36, h: 18 },
              confidence: 0.95,
              source: 'mistral+tesseract',
            },
          ],
        },
      ],
    }
    const regions = detectEditorWatermarks({ ocrResult: ocr, pageSizes: PAGE_SIZES })
    const filtered = filterOutWatermarkedScanElements(ocr, regions)
    expect(filtered.pages[0].elements).toHaveLength(1)
    expect(filtered.pages[0].elements[0].text).toBe('氏名')
  })

  it('複数ページにわたる除外（ページごとに独立処理）', () => {
    const ocr: ScanOcrResult = {
      pages: [
        {
          pageIndex: 0,
          pageSize: { widthPt: 595, heightPt: 842 },
          sourceMarkdown: '',
          elements: [
            {
              type: 'printed_text',
              text: 'Trial',
              bbox: { x: 480, y: 10, w: 50, h: 16 },
              confidence: 0.97,
              source: 'tesseract_only',
            },
          ],
        },
        {
          pageIndex: 1,
          pageSize: { widthPt: 595, heightPt: 842 },
          sourceMarkdown: '',
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
    const pageSizes2: PdfPageSize[] = [
      { page: 1, width: 595, height: 842 },
      { page: 2, width: 595, height: 842 },
    ]
    const regions = detectEditorWatermarks({ ocrResult: ocr, pageSizes: pageSizes2 })
    expect(regions).toHaveLength(1)
    const filtered = filterOutWatermarkedScanElements(ocr, regions)
    expect(filtered.pages[0].elements).toHaveLength(0) // page 1 の Trial 除外
    expect(filtered.pages[1].elements).toHaveLength(1) // page 2 の 部署 保持
  })
})
