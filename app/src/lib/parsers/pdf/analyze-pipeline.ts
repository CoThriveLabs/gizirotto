/**
 * PDF レイアウト解析パイプライン統合。
 *
 * Route Handler から呼ばれる「PDF buffer 入力 → fields + warnings 出力」の
 * end-to-end パイプライン。各 Extractor / Filter を順次連結する。
 *
 * フロー（検出順序厳守）:
 *   1. PdfClassifier で text / scan 判定
 *   2. テキスト PDF → TextPdfExtractor
 *      スキャン PDF or パス B → ScanPdfExtractor (Mistral OCR + Tesseract.js)
 *   3. PdfEditorWatermarkFilter = fields 候補から透かし除外
 *      ↑ 商用ロゴ検出より前に実施（誤検出回避）
 *   4. 商用ロゴ検出（ユーザー確認用 warnings）
 *   5. FieldSemanticExtractor で PdfField[] 構造抽出
 *   6. PdfLayoutBundle として返却
 */

import { classifyPdfBuffer } from './classifier'
import {
  extractTextPdfLayoutFromBuffer,
  type TextExtractionResult,
} from './text-extractor'
import { extractScanPdfLayout, type ScanOcrResult } from './scan-extractor'
import {
  detectEditorWatermarks,
  type WatermarkRegion,
} from './editor-watermark-filter'
import {
  extractFieldsBySemantic,
  type PdfFieldExtractorClient,
} from './field-semantic'
import {
  detectCommercialLogos,
  type LogoDetectionResult,
  type ClaudeVisionClient,
} from '../../copyright/logo-detector'
import type { PdfField } from '../../ai/schemas/pdf-field-schema'
import type { PdfPageSize, PdfClassification } from './pdf-types'

export interface AnalyzeInput {
  /** アップロードされた PDF バイト列 */
  pdfBytes: Uint8Array
  /** ユーザー UI で選択した入力経路 */
  inputPathType: 'A' | 'B'
  /** Claude / Anthropic client 注入（テスト用、本番は process.env から取得） */
  fieldExtractorClient?: PdfFieldExtractorClient
  claudeVisionClient?: ClaudeVisionClient
  /** L2 Claude Vision をスキップ（テスト / コスト削減） */
  skipClaudeVision?: boolean
}

export interface AnalyzeOutput {
  classification: PdfClassification
  fields: PdfField[]
  watermarkRegions: WatermarkRegion[]
  /** 商用ロゴ検出結果（needsUserConfirmation=true なら UI で警告表示） */
  commercialLogos: LogoDetectionResult
  /** 一般 warnings（フィッティング失敗等は Phase 5 で集約） */
  warnings: string[]
}

/**
 * PDF buffer → PdfField[] のフルパイプライン実行。
 *
 * Route Handler `/api/templates/pdf/analyze` から呼ばれる中核関数。
 */
export async function analyzePdfFull(input: AnalyzeInput): Promise<AnalyzeOutput> {
  const warnings: string[] = []

  // 一時診断ログ（付録 F-7 / PDFJS_WORKER_DEBUG=1 ガード、PDF 内容ゼロ）
  if (process.env.PDFJS_WORKER_DEBUG === '1') {
    const b = input.pdfBytes
    const buf = b?.buffer as ArrayBuffer | undefined
    const detached =
      buf && 'detached' in buf
        ? (buf as ArrayBuffer & { detached: boolean }).detached
        : 'n/a'
    // eslint-disable-next-line no-console
    console.error(
      `[analyze-pipeline] entry: dataType=${b?.constructor?.name ?? typeof b} dataLen=${b?.byteLength ?? 'n/a'} bufferByteLen=${buf?.byteLength ?? 'n/a'} byteOffset=${b?.byteOffset ?? 'n/a'} detached=${detached}`,
    )
  }

  // 1. 分類
  // 🛡 §11-1 #34 対処: classifyPdfBuffer は内部 worker / pdfjs 経路で
  // ArrayBuffer を transfer して原本を detached 化する（2026-05-25 真因確定）。
  // 後続 Extractor で原本 pdfBytes を無傷で使うため、classifier には独立コピーを渡す。
  const classifierBytes = new Uint8Array(input.pdfBytes.byteLength)
  classifierBytes.set(input.pdfBytes)
  const classification = await classifyPdfBuffer(classifierBytes)

  if (process.env.PDFJS_WORKER_DEBUG === '1') {
    const b = input.pdfBytes
    const buf = b?.buffer as ArrayBuffer | undefined
    const detached =
      buf && 'detached' in buf
        ? (buf as ArrayBuffer & { detached: boolean }).detached
        : 'n/a'
    // eslint-disable-next-line no-console
    console.error(
      `[analyze-pipeline] after-classifyPdfBuffer: dataLen=${b?.byteLength ?? 'n/a'} bufferByteLen=${buf?.byteLength ?? 'n/a'} detached=${detached}`,
    )
  }

  // 2. 経路別 Extractor 起動
  //    パス A + text: TextPdfExtractor 単独
  //    パス A + scan: ScanPdfExtractor 単独
  //    パス B: ScanPdfExtractor（書込済 → 白塗り前提）
  let textResult: TextExtractionResult | undefined
  let scanResult: ScanOcrResult | undefined
  const pageSizes: PdfPageSize[] = []

  if (input.inputPathType === 'A' && classification.pdfType === 'text') {
    textResult = await extractTextPdfLayoutFromBuffer(input.pdfBytes)
    pageSizes.push(...textResult.pageSizes)
  } else {
    // scan or path B
    scanResult = await extractScanPdfLayout(input.pdfBytes)
    for (const page of scanResult.pages) {
      pageSizes.push({
        page: page.pageIndex + 1,
        width: page.pageSize.widthPt,
        height: page.pageSize.heightPt,
      })
    }
  }

  // 3. PdfEditorWatermarkFilter（§3-9、§9-3a-2 検出順序厳守）
  //    商用ロゴ検出より前に実施（誤検出回避）
  const watermarkRegions = detectEditorWatermarks({
    rawText: textResult?.items,
    ocrResult: scanResult,
    pageSizes,
  })

  // 4. 商用ロゴ検出（§9-3 L1+L2）
  //    L1 keyword 入力: text PDF の本文 + scan PDF の markdown
  const textSources: string[] = []
  if (textResult) {
    textSources.push(textResult.items.map(i => i.text).join('\n'))
  }
  if (scanResult) {
    for (const page of scanResult.pages) {
      textSources.push(page.sourceMarkdown)
    }
  }
  // L2 用画像は Week 5 着手範囲外（Phase 5 で必要なら拡張）
  const commercialLogos = await detectCommercialLogos({
    textSources,
    skipClaudeVision: input.skipClaudeVision ?? true,
    claudeClient: input.claudeVisionClient,
  })

  // 5. FieldSemanticExtractor（§3-7、Claude Sonnet 4.6 + Structured Outputs）
  //    watermark 除外を内部で適用
  const fields = await extractFieldsBySemantic(
    {
      textResult,
      scanResult,
      watermarkRegions,
      inputPathType: input.inputPathType,
    },
    { client: input.fieldExtractorClient },
  )

  return {
    classification,
    fields,
    watermarkRegions,
    commercialLogos,
    warnings,
  }
}
