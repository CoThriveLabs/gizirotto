/**
 * FieldSemanticExtractor。
 *
 * 座標非介入。Claude Sonnet 4.6 + Structured Outputs（tool_use 強制）で
 * 「どの矩形がどのフィールドか」の意味判定のみ行う。座標は触らない
 * （Claude Vision の座標誤差 ±10〜30px を回避）。
 *
 * 入力（3 入力）:
 *   - Mistral OCR markdown（構造抽出）
 *   - Mistral OCR tables HTML（colspan/rowspan）
 *   - Tesseract.js bbox 付き word リスト（座標源、編集ツール透かし除外済）
 *
 * 出力:
 *   PdfField[] = §3-7 PdfFieldSchema 形式
 *
 * 既存 Phase 2 structure-extractor.ts の tool_use 強制 + cache_control パターンを継承。
 */

import Anthropic from '@anthropic-ai/sdk'
import type { ScanOcrResult } from './scan-extractor'
import type { TextExtractionResult } from './text-extractor'
import type { WatermarkRegion } from './editor-watermark-filter'
import {
  filterOutWatermarkedRawText,
  filterOutWatermarkedScanElements,
} from './editor-watermark-filter'
import {
  PdfTemplateSchemaZ,
  pdfTemplateExtractionJsonSchema,
  type PdfField,
  type PdfTemplateSchema,
} from '../../ai/schemas/pdf-field-schema'
import {
  SYSTEM_PROMPT_PDF_STRUCTURE,
  buildUserPromptPdfStructure,
} from '../../ai/prompts/pdf-structure'

const EXTRACTION_TOOL_NAME = 'extract_pdf_template_structure'

/**
 * 構造抽出用の最小クライアント interface。
 * Anthropic SDK 本体 / モック / 将来別実装 を差し替え可能にする
 * （既存 StructureExtractorClient と同パターン）。
 */
export type PdfFieldExtractorClient = {
  messages: {
    create: (...args: never[]) => Promise<{
      content: Array<{ type: string; [k: string]: unknown }>
    }>
  }
}

let _client: Anthropic | null = null

function getClient(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY_MISSING')
    _client = new Anthropic({ apiKey })
  }
  return _client
}

// =============================================================================
// 公開 API: ハイパス（テキスト / スキャン両方を受ける単一エントリ）
// =============================================================================

export interface ExtractPdfFieldsInput {
  /** テキスト PDF 経路: TextPdfExtractor 出力 */
  textResult?: TextExtractionResult
  /** スキャン PDF / パス B 経路: ScanPdfExtractor 出力 */
  scanResult?: ScanOcrResult
  /** PDF 編集ツール透かし検出済領域（fields 候補から除外する用途） */
  watermarkRegions?: WatermarkRegion[]
  /** 入力経路（プロンプト分岐用、UI でユーザー選択した値） */
  inputPathType: 'A' | 'B'
}

export interface ExtractPdfFieldsOptions {
  client?: PdfFieldExtractorClient
}

/**
 * 3 入力から fields[] を抽出する。
 *
 * 内部フロー:
 *   1. watermarkRegions で text / ocr から透かし要素を除外
 *   2. markdown / tables HTML / bbox 付き word を抽出
 *   3. Claude tool_use で PdfField[] を取得
 *   4. zod validate
 */
export async function extractFieldsBySemantic(
  input: ExtractPdfFieldsInput,
  options: ExtractPdfFieldsOptions = {},
): Promise<PdfField[]> {
  const client = options.client ?? (getClient() as unknown as PdfFieldExtractorClient)
  const model = process.env.ANTHROPIC_MODEL
  if (!model) throw new Error('ANTHROPIC_MODEL_MISSING')

  if (!input.textResult && !input.scanResult) {
    throw new Error('FIELD_SEMANTIC_INPUT_EMPTY')
  }

  // 1. 透かし除外
  const filteredText = input.textResult
    ? {
        ...input.textResult,
        items: filterOutWatermarkedRawText(input.textResult.items, input.watermarkRegions ?? []),
      }
    : undefined
  const filteredScan = input.scanResult
    ? filterOutWatermarkedScanElements(input.scanResult, input.watermarkRegions ?? [])
    : undefined

  // 2. 3 入力を組み立て
  const userPrompt = buildClaudeUserPrompt({
    textResult: filteredText,
    scanResult: filteredScan,
    inputPathType: input.inputPathType,
  })
  // _meta フィールド削除に伴い当面未使用（SDK upgrade 後に再導入候補）
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _classification: 'text' | 'scan' = filteredText && filteredText.items.length > 0 ? 'text' : 'scan'

  // 3. Claude tool_use 強制
  // SDK v0.32 系の TextBlockParam 型には cache_control がないが、
  // 実 API（prompt caching ベータ）では受理される（既存 structure-extractor.ts と同じ扱い）
  const params = {
    model,
    max_tokens: 4096,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT_PDF_STRUCTURE,
        cache_control: { type: 'ephemeral' },
      },
    ],
    tools: [
      {
        name: EXTRACTION_TOOL_NAME,
        description:
          'Extract structured PDF template fields with bbox from Mistral OCR markdown / tables HTML and Tesseract.js bbox-tagged words.',
        input_schema: pdfTemplateExtractionJsonSchema,
      },
    ],
    tool_choice: { type: 'tool', name: EXTRACTION_TOOL_NAME },
    messages: [{ role: 'user', content: userPrompt }],
    // ※ `_meta` は @anthropic-ai/sdk 0.32.1 では未サポート（HTTP 400
    //   "Extra inputs are not permitted"）。classification は呼出側で
    //   log / metrics に出すか、Phase 4 で SDK upgrade 後に再導入を検討。
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response = await (client.messages.create as any)(params)

  const toolUse = (
    response.content as Array<{ type: string; name?: string; input?: unknown }>
  ).find(c => c.type === 'tool_use' && c.name === EXTRACTION_TOOL_NAME)
  if (!toolUse) throw new Error('NO_TOOL_USE_BLOCK')

  const parsed: PdfTemplateSchema = PdfTemplateSchemaZ.parse(toolUse.input)
  return parsed.fields
}

// =============================================================================
// 内部: 3 入力組み立て
// =============================================================================

function buildClaudeUserPrompt(input: {
  textResult?: TextExtractionResult
  scanResult?: ScanOcrResult
  inputPathType: 'A' | 'B'
}): string {
  // 3 入力（markdown / tablesHtml / bboxWords / pageSizes / classification）に正規化
  const markdown = collectMarkdown(input.scanResult)
  const tablesHtml = collectTablesHtml(input.scanResult)
  const bboxWords = collectBboxWords(input.textResult, input.scanResult)
  const pageSizes = collectPageSizes(input.textResult, input.scanResult)
  const classification: 'text' | 'scan' =
    input.textResult && input.textResult.items.length > 0 ? 'text' : 'scan'

  return buildUserPromptPdfStructure({
    markdown,
    tablesHtml,
    bboxWords,
    pageSizes,
    classification,
    inputPathType: input.inputPathType,
  })
}

function collectMarkdown(scan?: ScanOcrResult): string {
  if (!scan) return ''
  return scan.pages
    .map(p => p.sourceMarkdown)
    .filter(s => s && s.length > 0)
    .join('\n\n---\n\n')
}

function collectTablesHtml(scan?: ScanOcrResult): string[] {
  if (!scan) return []
  // ScanOcrResult.pages[].elements の中で type='table_cell' は tableHtml を持つが
  // 同じ table の中で重複する。unique 化して 1 テーブル 1 HTML にする
  const seen = new Set<string>()
  const out: string[] = []
  for (const page of scan.pages) {
    for (const el of page.elements) {
      if (el.type === 'table_cell' && el.tableHtml && !seen.has(el.tableHtml)) {
        seen.add(el.tableHtml)
        out.push(el.tableHtml)
      }
    }
  }
  return out
}

function collectBboxWords(
  text?: TextExtractionResult,
  scan?: ScanOcrResult,
): Array<{
  page: number
  text: string
  bbox: { x: number; y: number; w: number; h: number }
  confidence: number
}> {
  const out: Array<{
    page: number
    text: string
    bbox: { x: number; y: number; w: number; h: number }
    confidence: number
  }> = []

  // テキスト PDF: pdfjs 直接座標（confidence は 1.0 固定、最高品質）
  if (text) {
    for (const it of text.items) {
      out.push({
        page: it.page,
        text: it.text,
        bbox: it.bbox,
        confidence: 1.0,
      })
    }
  }

  // スキャン PDF: Tesseract bbox + Mistral 由来 confidence
  if (scan) {
    for (const page of scan.pages) {
      const page1 = page.pageIndex + 1
      for (const el of page.elements) {
        // v0.5 案 B（先頭集約 + 後続空文字化）で生まれる text='' element は
        // Claude prompt に bbox 付きで混入するとトークン消費 + 解釈混乱の原因になるため skip。
        if (el.text.length === 0) continue
        out.push({
          page: page1,
          text: el.text,
          bbox: el.bbox,
          confidence: el.confidence,
        })
      }
    }
  }

  return out
}

function collectPageSizes(
  text?: TextExtractionResult,
  scan?: ScanOcrResult,
): Array<{ page: number; widthPt: number; heightPt: number }> {
  if (text && text.pageSizes.length > 0) {
    return text.pageSizes.map(p => ({
      page: p.page,
      widthPt: p.width,
      heightPt: p.height,
    }))
  }
  if (scan) {
    return scan.pages.map(p => ({
      page: p.pageIndex + 1,
      widthPt: p.pageSize.widthPt,
      heightPt: p.pageSize.heightPt,
    }))
  }
  return []
}
