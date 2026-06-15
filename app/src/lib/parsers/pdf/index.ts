import type { TemplateParser, IntermediateFormat } from '../types'
import { extractPreviewText } from './unpdf-preview'

/**
 * format-agnostic な PdfParser（設計書 v1.4.1 §3-1 / R-1）。
 *
 * - 公開 interface（TemplateParser<'pdf'>）は変更しない
 * - PDF レイアウト保持の複雑性は src/lib/parsers/pdf/ 配下に内包
 * - Phase 2 までの単純テキスト抽出は unpdf-preview に集約
 * - Phase 2.5 以降のレイアウト保持パイプラインは classifier / text-extractor /
 *   scan-extractor / whiteout-pipeline / editor-watermark-filter /
 *   field-semantic / bundle-builder のサブモジュールに分解
 *
 * 仕様書 §1-2 v1.6.1 のとおり、unpdf は「軽量プレビュー専用」用途に限定する。
 * 本ファイルは format-agnostic な共通 interface を提供する薄いラッパーとして
 * 機能し、レイアウト保持に必要なメタデータは parsePdfLayout
 * （Phase 2.5 Week 2 で実装予定）経由で取得する。
 */
export const pdfParser: TemplateParser<'pdf'> = {
  format: 'pdf',
  async parse(file: ArrayBuffer | string): Promise<IntermediateFormat> {
    if (typeof file === 'string') {
      throw new Error('PDF_PARSER_EXPECTS_ARRAY_BUFFER')
    }
    const { text } = await extractPreviewText(file)
    return { kind: 'text', text }
  },
}

// PDF 専用型 / Classifier 等を再エクスポート（呼び出し側の import 集約のため）
export type {
  PdfClassification,
  InputPathChoice,
  PdfBox,
  PdfPageSize,
  RawTextItem,
} from './pdf-types'
export { classifyPdfBuffer, classifyPdfDocument } from './classifier'
export { extractPreviewText } from './unpdf-preview'
export {
  extractTextPdfLayout,
  extractTextPdfLayoutFromBuffer,
  type TextExtractionResult,
} from './text-extractor'
export {
  extractScanPdfLayout,
  type ScanOcrResult,
  type ScanOcrResultPage,
  type ScanElement,
  type ScanElementType,
  type ExtractScanPdfOptions,
} from './scan-extractor'
export {
  applyWhiteout,
  suggestWhiteoutCandidates,
  DEFAULT_BG_COLOR_WHITE,
  type WhiteoutBox,
  type WhiteoutSource,
  type RgbColor,
} from './whiteout-pipeline'
export {
  renderPdfPagesToPng,
  type RasterizedPage,
  type RasterizeOptions,
} from './pdf-page-rasterizer'
export {
  createJpnWorker,
  runTesseractOnImage,
  type TesseractWord,
  type TesseractLine,
  type TesseractImageResult,
} from './tesseract-runner'
export {
  detectEditorWatermarks,
  detectEditorWatermarksInMarkdown,
  filterOutWatermarkedRawText,
  filterOutWatermarkedScanElements,
  type WatermarkRegion,
  type WatermarkDetectionReason,
  type DetectEditorWatermarksInput,
} from './editor-watermark-filter'
export {
  EDITOR_WATERMARK_KEYWORDS,
  type EditorWatermarkKeyword,
} from './editor-watermark-keywords'
export {
  extractFieldsBySemantic,
  type PdfFieldExtractorClient,
  type ExtractPdfFieldsInput,
  type ExtractPdfFieldsOptions,
} from './field-semantic'
export {
  buildTemplateBundle,
  type TemplateBundle,
  type TemplateBundleInput,
} from './bundle-builder'
