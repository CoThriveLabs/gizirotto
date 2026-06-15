import type { PdfClassification } from './pdf-types'
import { PDF_CLASSIFIER_TEXT_THRESHOLD } from './pdf-types'

/**
 * PdfClassifier。
 *
 * pdfjs-dist の getTextContent を 1 リクエストで読み、合計文字数で
 * 'text'（テキストレイヤ有り）/ 'scan'（スキャン画像）を判定する。
 * 追加コストなし（後段 Extractor が getTextContent を再使用する想定）。
 *
 * 重要:
 *   パス B（書込済 → 白塗り）はユーザー UI で明示選択する。
 *   Classifier は判定結果を返すのみで自動で B を選ばない。
 *
 * 実装方針:
 *   pdfjs-serverless を dynamic import して Edge Runtime 互換性を確保。
 *   classifyPdfBuffer は呼び出し側で Buffer を直接渡せるシュガー。
 */

export interface ClassifyPdfOptions {
  /** 50 文字以上で 'text' 判定 */
  textThreshold?: number
}

/**
 * Buffer / Uint8Array から直接分類する公開関数。
 * 内部で pdfjs-serverless を dynamic import するため、import コスト軽減
 * のために呼び出し元側で並列化することを推奨。
 */
export async function classifyPdfBuffer(
  data: Uint8Array,
  options: ClassifyPdfOptions = {},
): Promise<PdfClassification> {
  const { getDocument } = await import('pdfjs-serverless')
  const loadingTask = getDocument({
    data,
    useSystemFonts: true,
    isEvalSupported: false,
  })
  const pdf = await loadingTask.promise
  try {
    return await classifyPdfDocument(pdf, options)
  } finally {
    await pdf.destroy()
  }
}

/**
 * 既にロード済みの PDFDocumentProxy を分類する。
 * 後段 Extractor がドキュメントを使い回す場合はこちらを使う。
 *
 * 注意: pdfjs-dist の PDFDocumentProxy 型を直接 import すると
 * pdfjs-dist 本体のトップレベル評価が走り Edge Runtime で
 * `DOMMatrix is not defined` 等のエラーになる。そのため、
 * ここでは型を unknown 経由で受ける構造的ダックタイピングにする。
 */
export interface PdfDocumentLike {
  numPages: number
  getPage(pageNumber: number): Promise<{
    getTextContent(): Promise<{ items: Array<unknown> }>
  }>
}

export async function classifyPdfDocument(
  pdf: PdfDocumentLike,
  options: ClassifyPdfOptions = {},
): Promise<PdfClassification> {
  const threshold = options.textThreshold ?? PDF_CLASSIFIER_TEXT_THRESHOLD
  const pageCount = pdf.numPages
  let totalChars = 0

  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i)
    const tc = await page.getTextContent()
    for (const item of tc.items) {
      const str = extractStr(item)
      if (str) totalChars += str.length
    }
  }

  return {
    pdfType: totalChars > threshold ? 'text' : 'scan',
    totalCharCount: totalChars,
    pageCount,
  }
}

function extractStr(item: unknown): string | undefined {
  if (
    item !== null
    && typeof item === 'object'
    && 'str' in item
    && typeof (item as { str: unknown }).str === 'string'
  ) {
    return (item as { str: string }).str
  }
  return undefined
}
