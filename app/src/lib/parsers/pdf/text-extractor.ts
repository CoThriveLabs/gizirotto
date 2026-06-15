import type { PdfPageSize, RawTextItem } from './pdf-types'

/**
 * TextPdfExtractor（仕様書 v1.6.1 §1-2 / 設計書 v1.4.1 §3-4）。
 *
 * テキストレイヤを持つ PDF から `getTextContent` の transform 行列で
 * ±0.5px 精度の座標を取得する（テキスト PDF 専用）。
 *
 * - PDF 座標系は左下原点。アプリ内部表現は左上原点 (PdfBox.y は上端)
 * - pdfjs-serverless 経由で Edge Runtime 互換性を維持
 * - スキャン PDF（テキストレイヤ無し）に対しても呼び出し可能、items=[] を返す
 *
 * 現状はテキスト PDF の pdfjs 結果を返すのみ。テーブル領域選択的 Mistral 併用は未実装。
 */

export interface TextExtractionResult {
  items: RawTextItem[]
  pageSizes: PdfPageSize[]
}

interface PdfTextItemInternal {
  str: string
  /** [scaleX, skewY, skewX, scaleY, translateX, translateY] */
  transform: number[]
  width: number
  height: number
  fontName: string
}

interface PdfPageLike {
  getViewport(options: { scale: number }): { width: number; height: number }
  getTextContent(): Promise<{ items: Array<unknown> }>
}

interface PdfDocumentLike {
  numPages: number
  getPage(pageNumber: number): Promise<PdfPageLike>
  destroy(): Promise<void>
}

/**
 * Buffer / Uint8Array から直接抽出するシュガー。
 * 内部で pdfjs-serverless を dynamic import + ドキュメントを破棄まで面倒見る。
 */
export async function extractTextPdfLayoutFromBuffer(
  data: Uint8Array,
): Promise<TextExtractionResult> {
  const { getDocument } = await import('pdfjs-serverless')
  const pdf = (await getDocument({
    data,
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise) as unknown as PdfDocumentLike
  try {
    return await extractTextPdfLayout(pdf)
  } finally {
    await pdf.destroy()
  }
}

/**
 * 既にロード済みの PDFDocumentProxy から抽出する。
 * 後段 Extractor がドキュメントを使い回す場合はこちらを使う。
 */
export async function extractTextPdfLayout(
  pdf: PdfDocumentLike,
): Promise<TextExtractionResult> {
  const items: RawTextItem[] = []
  const pageSizes: PdfPageSize[] = []

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p)
    const viewport = page.getViewport({ scale: 1.0 })
    pageSizes.push({ page: p, width: viewport.width, height: viewport.height })

    const tc = await page.getTextContent()
    for (const raw of tc.items) {
      const item = toTextItem(raw)
      if (!item) continue
      // transform: [scaleX, skewY, skewX, scaleY, translateX, translateY]
      // フォントサイズは scaleX, skewY のベクトル長で近似（pdfjs 公式の慣行）
      const fontSize = Math.hypot(item.transform[0], item.transform[1])
      items.push({
        page: p,
        text: item.str,
        bbox: {
          x: item.transform[4],
          // PDF 座標系（左下原点 transform[5] = 文字 baseline）→
          // アプリ内部表現（左上原点 bbox.y = 文字の上端）
          y: viewport.height - item.transform[5] - item.height,
          w: item.width,
          h: item.height,
        },
        fontName: item.fontName,
        fontSize,
      })
    }
  }

  return { items, pageSizes }
}

/**
 * pdfjs の TextItem は TextMarkedContent と union のため、
 * 必要なフィールドが揃っている場合のみ採用する構造的ダックタイピング。
 */
function toTextItem(raw: unknown): PdfTextItemInternal | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.str !== 'string') return undefined
  if (!Array.isArray(r.transform) || r.transform.length < 6) return undefined
  if (typeof r.width !== 'number') return undefined
  if (typeof r.height !== 'number') return undefined
  if (typeof r.fontName !== 'string') return undefined
  return {
    str: r.str,
    transform: r.transform as number[],
    width: r.width,
    height: r.height,
    fontName: r.fontName,
  }
}
