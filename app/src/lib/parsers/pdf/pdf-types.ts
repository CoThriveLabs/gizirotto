/**
 * PDF レイアウト保持パイプライン専用の型定義。
 * 設計書 v1.4.1 §3 / 付録 A 準拠。
 *
 * format-agnostic な公開 interface（TemplateParser<'pdf'>）の内側に閉じる型。
 * 外向け interface は src/lib/parsers/types.ts の IntermediateFormat に統合される。
 */

/** PDF 内の bbox。pdfjs / Mistral OCR 共通の座標表現（pt 単位、左上原点） */
export interface PdfBox {
  x: number
  y: number
  w: number
  h: number
}

export interface PdfPageSize {
  page: number
  width: number
  height: number
}

/** PdfClassifier 出力（§3-3） */
export interface PdfClassification {
  pdfType: 'text' | 'scan'
  totalCharCount: number
  pageCount: number
}

/** アップロード UI でユーザーが選択する入力経路（仕様書 §0-3.5 要件 1） */
export type InputPathChoice = 'A' | 'B'

/** PdfClassifier の判定閾値 */
export const PDF_CLASSIFIER_TEXT_THRESHOLD = 50

/**
 * raw text 抽出結果（pdfjs-dist `getTextContent` 由来）。
 * テキスト PDF (TextPdfExtractor) のみで生成される。
 */
export interface RawTextItem {
  page: number
  text: string
  bbox: PdfBox
  fontName: string
  fontSize: number
}
