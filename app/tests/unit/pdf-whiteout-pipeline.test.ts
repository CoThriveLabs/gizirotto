/**
 * WhiteoutPipeline unit test（Phase 2.5 Week 2 / 設計書 v1.4.2 §3-6 ユーザー UI 主導）。
 *
 * - applyWhiteout: 確定済 WhiteoutBox[] を pdf-lib drawRectangle で塗る本体
 * - suggestWhiteoutCandidates: ScanOcrResult から手書き想定要素を補助サジェスト
 *
 * テスト戦略:
 *   - pdf-lib で空白 PDF を生成 → applyWhiteout で矩形塗り → 入力より bytes 増加確認
 *   - 範囲外 page index は skip 動作確認（throw しない）
 *   - 複数 box / 複数 page の動作
 *   - 座標系変換（左上原点 → pdf-lib 左下原点）動作確認
 *   - suggestWhiteoutCandidates の handwriting 抽出ロジック
 */
import { describe, it, expect } from 'vitest'
import {
  applyWhiteout,
  suggestWhiteoutCandidates,
  DEFAULT_BG_COLOR_WHITE,
  type WhiteoutBox,
} from '@/lib/parsers/pdf/whiteout-pipeline'
import type { ScanOcrResult } from '@/lib/parsers/pdf/scan-extractor'

async function makeBlankPdf(pageCount = 1, width = 595, height = 842): Promise<Uint8Array> {
  const { PDFDocument } = await import('pdf-lib')
  const pdf = await PDFDocument.create()
  for (let i = 0; i < pageCount; i++) {
    pdf.addPage([width, height])
  }
  return await pdf.save()
}

describe('WhiteoutPipeline.applyWhiteout', () => {
  it('白塗り矩形を 1 つ追加すると元 PDF よりバイト数が増える', async () => {
    const blank = await makeBlankPdf(1)
    const boxes: WhiteoutBox[] = [
      {
        page: 1,
        bbox: { x: 100, y: 200, w: 200, h: 50 },
        estimatedBgColor: DEFAULT_BG_COLOR_WHITE,
        source: 'auto_suggestion',
      },
    ]
    const result = await applyWhiteout(blank, boxes)
    expect(result.byteLength).toBeGreaterThan(blank.byteLength)
  })

  it('複数ページ × 複数 box を処理できる', async () => {
    const blank = await makeBlankPdf(3)
    const boxes: WhiteoutBox[] = [
      { page: 1, bbox: { x: 50, y: 100, w: 100, h: 30 }, estimatedBgColor: DEFAULT_BG_COLOR_WHITE, source: 'auto_suggestion' },
      { page: 2, bbox: { x: 50, y: 200, w: 100, h: 30 }, estimatedBgColor: DEFAULT_BG_COLOR_WHITE, source: 'manual' },
      { page: 3, bbox: { x: 50, y: 300, w: 100, h: 30 }, estimatedBgColor: DEFAULT_BG_COLOR_WHITE, source: 'auto_suggestion' },
    ]
    const result = await applyWhiteout(blank, boxes)
    expect(result.byteLength).toBeGreaterThan(blank.byteLength)
  })

  it('範囲外 page index は skip して例外を投げない', async () => {
    const blank = await makeBlankPdf(1)
    const boxes: WhiteoutBox[] = [
      { page: 99, bbox: { x: 0, y: 0, w: 10, h: 10 }, estimatedBgColor: DEFAULT_BG_COLOR_WHITE, source: 'auto_suggestion' },
      { page: 0, bbox: { x: 0, y: 0, w: 10, h: 10 }, estimatedBgColor: DEFAULT_BG_COLOR_WHITE, source: 'auto_suggestion' },
    ]
    await expect(applyWhiteout(blank, boxes)).resolves.toBeInstanceOf(Uint8Array)
  })

  it('boxes=[] は元 PDF とほぼ同じバイト数で完走する', async () => {
    const blank = await makeBlankPdf(1)
    const result = await applyWhiteout(blank, [])
    // pdf-lib の save は object stream を再構築するので、入力と完全一致しない可能性あり
    // 大幅増加していないことのみ確認
    expect(result.byteLength).toBeGreaterThan(0)
    expect(result.byteLength).toBeLessThan(blank.byteLength + 500)
  })

  it('estimatedBgColor が非白でも処理できる（グレー背景セル想定）', async () => {
    const blank = await makeBlankPdf(1)
    const boxes: WhiteoutBox[] = [
      {
        page: 1,
        bbox: { x: 100, y: 100, w: 200, h: 30 },
        estimatedBgColor: { r: 232, g: 232, b: 232 }, // #E8E8E8 薄グレー
        source: 'auto_suggestion',
      },
    ]
    const result = await applyWhiteout(blank, boxes)
    expect(result.byteLength).toBeGreaterThan(blank.byteLength)
  })

  it('G1-④ パスB: 出力は useObjectStreams:false（非オブジェクトストリーム）で保存される', async () => {
    // 修正の本質: pdf-lib 既定 useObjectStreams:true は画像XObjectの参照表現を変え、
    // pdfjs→@napi-rs/canvas のレンダで落ちる。false 指定で xref table 形式になり互換が戻る。
    // バイト列に従来 ObjStm 形式が含まれず、素直な xref で再 load できることを確認。
    const blank = await makeBlankPdf(2)
    const boxes: WhiteoutBox[] = [
      {
        page: 1,
        bbox: { x: 100, y: 200, w: 200, h: 50 },
        estimatedBgColor: DEFAULT_BG_COLOR_WHITE,
        source: 'manual',
      },
    ]
    const out = await applyWhiteout(blank, boxes)
    const text = Buffer.from(out).toString('latin1')

    // %PDF ヘッダを持つ有効な PDF
    expect(text.startsWith('%PDF-')).toBe(true)
    // useObjectStreams:false なら ObjStm（オブジェクトストリーム）を使わない
    expect(text.includes('/ObjStm')).toBe(false)
    // 古い xref テーブル形式（'xref' キーワード）で書かれる
    expect(text.includes('\nxref')).toBe(true)

    // 出力 PDF が壊れておらず、pdf-lib で再 load してページ数が保たれる
    const { PDFDocument } = await import('pdf-lib')
    const reloaded = await PDFDocument.load(out)
    expect(reloaded.getPageCount()).toBe(2)
  })

  it('座標系変換: page.y=0 で h=50 は pdf-lib 内部で pageHeight-50 に配置される', async () => {
    // 直接座標を検査する手段は pdf-lib では公開されていないため、
    // y=0 の矩形が page bottom に正しく置かれるかは E2E 視覚検証で確認（Week 6 T-3）。
    // ここでは「y=0 でも例外なく完走」を確認するに留める。
    const blank = await makeBlankPdf(1)
    const boxes: WhiteoutBox[] = [
      {
        page: 1,
        bbox: { x: 0, y: 0, w: 50, h: 50 },
        estimatedBgColor: DEFAULT_BG_COLOR_WHITE,
        source: 'auto_suggestion',
      },
    ]
    await expect(applyWhiteout(blank, boxes)).resolves.toBeInstanceOf(Uint8Array)
  })
})

describe('WhiteoutPipeline.suggestWhiteoutCandidates (v1.4.2 §3-6)', () => {
  it('handwriting 要素のみを抽出して WhiteoutBox に変換', () => {
    const ocr: ScanOcrResult = {
      pages: [
        {
          pageIndex: 0,
          pageSize: { widthPt: 595, heightPt: 842 },
          sourceMarkdown: '',
          elements: [
            {
              type: 'handwriting',
              text: '山田',
              bbox: { x: 100, y: 200, w: 50, h: 24 },
              confidence: 0.45,
              source: 'tesseract_only',
            },
            {
              type: 'printed_text',
              text: '氏名',
              bbox: { x: 50, y: 200, w: 36, h: 24 },
              confidence: 0.95,
              source: 'mistral+tesseract',
            },
            {
              type: 'table_cell',
              text: '日時',
              bbox: { x: 50, y: 240, w: 36, h: 24 },
              confidence: 0.9,
              source: 'mistral+tesseract',
              tableHtml: '<table><tr><td>日時</td></tr></table>',
            },
          ],
        },
      ],
    }
    const result = suggestWhiteoutCandidates(ocr)
    expect(result).toHaveLength(1)
    expect(result[0].page).toBe(1) // 0-based → 1-based 変換
    expect(result[0].bbox).toEqual({ x: 100, y: 200, w: 50, h: 24 })
    expect(result[0].source).toBe('auto_suggestion')
    expect(result[0].estimatedBgColor).toEqual(DEFAULT_BG_COLOR_WHITE)
  })

  it('複数ページの handwriting を統合して返す', () => {
    const ocr: ScanOcrResult = {
      pages: [
        {
          pageIndex: 0,
          pageSize: { widthPt: 595, heightPt: 842 },
          sourceMarkdown: '',
          elements: [
            {
              type: 'handwriting',
              text: 'a',
              bbox: { x: 10, y: 10, w: 5, h: 5 },
              confidence: 0.5,
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
              type: 'handwriting',
              text: 'b',
              bbox: { x: 20, y: 30, w: 5, h: 5 },
              confidence: 0.6,
              source: 'tesseract_only',
            },
            {
              type: 'printed_text',
              text: 'c',
              bbox: { x: 40, y: 50, w: 5, h: 5 },
              confidence: 0.95,
              source: 'mistral+tesseract',
            },
          ],
        },
      ],
    }
    const result = suggestWhiteoutCandidates(ocr)
    expect(result).toHaveLength(2)
    expect(result.map(b => b.page)).toEqual([1, 2])
  })

  it('handwriting がなければ空配列を返す', () => {
    const ocr: ScanOcrResult = {
      pages: [
        {
          pageIndex: 0,
          pageSize: { widthPt: 595, heightPt: 842 },
          sourceMarkdown: '',
          elements: [
            {
              type: 'printed_text',
              text: 'x',
              bbox: { x: 0, y: 0, w: 10, h: 10 },
              confidence: 0.99,
              source: 'mistral+tesseract',
            },
          ],
        },
      ],
    }
    expect(suggestWhiteoutCandidates(ocr)).toEqual([])
  })
})
