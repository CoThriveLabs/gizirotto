/**
 * scan-extractor mergePageData unit test（設計 v0.5 案 B / §7 Unit）。
 *
 * 検証対象: テーブル統合 pass（L383-429 + v0.5 上書きブロック）で
 *   Mistral tables HTML の cell text が ScanElement.text に上書きされること。
 *
 * 設計 §12-2 採用方針: 該当 range の「先頭要素に Mistral cell text を集約 + 後続を空文字化」
 *   → layout-cluster.ts の word join 結果がそのまま Mistral text になる。
 *
 * 知人 PDF 内容は assertion に書かない（§11-3 / 依頼書 §3-7）。
 * 本テストでは合成データのみ使用（議事内容文字列は意味のあるダミー）。
 */
import { describe, it, expect } from 'vitest'
import {
  __internal_scan_extractor,
  type __Internal_MistralPageLike,
  type __Internal_TesseractPageData,
} from '@/lib/parsers/pdf/scan-extractor'

const { mergePageData } = __internal_scan_extractor

function makeTPage(
  words: Array<{ text: string; x: number; y: number; w: number; h: number; conf?: number }>,
): __Internal_TesseractPageData {
  return {
    pageIndex0: 0,
    pixelWidth: 1000,
    pixelHeight: 1000,
    pagePtSize: { page: 1, width: 1000, height: 1000 },
    words: words.map(w => ({
      text: w.text,
      bbox: { x0: w.x, y0: w.y, x1: w.x + w.w, y1: w.y + w.h },
      confidence: w.conf ?? 95,
    })),
  }
}

function makeMPage(tables: Array<{ content: string }>): __Internal_MistralPageLike {
  return {
    index: 0,
    markdown: '',
    dimensions: { dpi: 200, width: 1000, height: 1000 },
    tables: tables.map((t, i) => ({ id: `t${i}`, content: t.content, format: 'html' })),
    confidenceScores: { wordConfidenceScores: [] },
  }
}

describe('mergePageData / v0.5 案 B: Mistral table cell text 上書き', () => {
  it('1. 連続 word が cell text と一致する場合、先頭要素に Mistral text を集約し後続は空文字化される', () => {
    // Tesseract が「2026年5月24日」を 6 word に分割し、Mistral cell は連結された 1 セル
    const tPage = makeTPage([
      { text: '2026', x: 100, y: 100, w: 40, h: 20 },
      { text: '年', x: 140, y: 100, w: 20, h: 20 },
      { text: '5', x: 160, y: 100, w: 10, h: 20 },
      { text: '月', x: 170, y: 100, w: 20, h: 20 },
      { text: '24', x: 190, y: 100, w: 20, h: 20 },
      { text: '日', x: 210, y: 100, w: 20, h: 20 },
    ])
    const mPage = makeMPage([
      { content: '<table><tr><td>2026年5月24日</td></tr></table>' },
    ])
    const result = mergePageData(mPage, tPage)
    // 先頭要素に Mistral cell text が入る
    expect(result.elements[0].text).toBe('2026年5月24日')
    expect(result.elements[0].type).toBe('table_cell')
    // 後続 5 要素は空文字化（layout-cluster の join で復元される設計）
    for (let i = 1; i < 6; i++) {
      expect(result.elements[i].text).toBe('')
      expect(result.elements[i].type).toBe('table_cell')
    }
  })

  it('2. cell text が一致しない場合、Tesseract text が維持される（後方互換）', () => {
    const tPage = makeTPage([
      { text: 'foo', x: 100, y: 100, w: 30, h: 20 },
      { text: 'bar', x: 130, y: 100, w: 30, h: 20 },
    ])
    const mPage = makeMPage([
      { content: '<table><tr><td>まったく違うセル</td></tr></table>' },
    ])
    const result = mergePageData(mPage, tPage)
    expect(result.elements[0].text).toBe('foo')
    expect(result.elements[1].text).toBe('bar')
    expect(result.elements[0].type).toBe('printed_text')
    expect(result.elements[1].type).toBe('printed_text')
  })

  it('3. table 外の平文 word は影響を受けない（案 A 未実装の確認）', () => {
    // Mistral tables HTML には「日時」だけが入っている → 平文 word「概要」「説明」には触らない
    const tPage = makeTPage([
      { text: '日時', x: 100, y: 100, w: 30, h: 20 },
      { text: '概要', x: 100, y: 200, w: 30, h: 20 },
      { text: '説明', x: 100, y: 300, w: 30, h: 20 },
    ])
    const mPage = makeMPage([
      { content: '<table><tr><th>日時</th></tr></table>' },
    ])
    const result = mergePageData(mPage, tPage)
    // 完全一致は table_cell 化される（既存挙動）
    expect(result.elements[0].text).toBe('日時')
    expect(result.elements[0].type).toBe('table_cell')
    // 平文 word は維持
    expect(result.elements[1].text).toBe('概要')
    expect(result.elements[1].type).toBe('printed_text')
    expect(result.elements[2].text).toBe('説明')
    expect(result.elements[2].type).toBe('printed_text')
  })

  it('4. 1 文字以下のセルは partial match の対象外（既存ガード維持）', () => {
    // Mistral cell 「a」は length=1 → partial match skip
    const tPage = makeTPage([
      { text: 'x', x: 100, y: 100, w: 10, h: 20 },
      { text: 'y', x: 110, y: 100, w: 10, h: 20 },
    ])
    const mPage = makeMPage([
      { content: '<table><tr><td>a</td></tr></table>' },
    ])
    const result = mergePageData(mPage, tPage)
    // a は完全一致もしないので element は無改変
    expect(result.elements[0].text).toBe('x')
    expect(result.elements[1].text).toBe('y')
    expect(result.elements[0].type).toBe('printed_text')
    expect(result.elements[1].type).toBe('printed_text')
  })

  it('5. HTML entity decode が text 上書きでも効く', () => {
    // Mistral HTML 内 entity → decode 後の文字列で partial match → 上書き
    const tPage = makeTPage([
      { text: 'A', x: 100, y: 100, w: 10, h: 20 },
      { text: '&', x: 110, y: 100, w: 10, h: 20 },
      { text: 'B', x: 120, y: 100, w: 10, h: 20 },
    ])
    const mPage = makeMPage([
      { content: '<table><tr><td>A&amp;B</td></tr></table>' },
    ])
    const result = mergePageData(mPage, tPage)
    // 連結 'A&B' が decode 後 cell 'A&B' と一致 → 先頭集約
    expect(result.elements[0].text).toBe('A&B')
    expect(result.elements[0].type).toBe('table_cell')
    expect(result.elements[1].text).toBe('')
    expect(result.elements[2].text).toBe('')
  })
})
