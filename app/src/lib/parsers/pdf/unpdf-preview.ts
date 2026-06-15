import { extractText, getDocumentProxy } from 'unpdf'

/**
 * 軽量プレビュー専用 PDF テキスト抽出（仕様書 v1.6.1 §1-2 / 設計書 v1.4.1 §2-2）。
 *
 * アップロード前の「このファイル合ってる？」確認画面のみで使用する。
 * 本パイプライン（PdfClassifier 以降）には絶対に介在させない。
 *
 * Vercel/Edge Runtime での実行を想定（unpdf は WASM 不使用、軽量）。
 */
export async function extractPreviewText(file: ArrayBuffer): Promise<{
  text: string
  pageCount: number
}> {
  const pdf = await getDocumentProxy(new Uint8Array(file))
  const { text, totalPages } = await extractText(pdf, { mergePages: true })
  return {
    text: Array.isArray(text) ? text.join('\n') : text,
    pageCount: totalPages,
  }
}
