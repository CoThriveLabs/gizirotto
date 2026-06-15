import type { PdfBox, PdfPageSize, RawTextItem } from './pdf-types'
import type { ScanOcrResult, ScanElement } from './scan-extractor'
import { EDITOR_WATERMARK_KEYWORDS } from './editor-watermark-keywords'

// 再エクスポート（呼び出し側が editor-watermark-filter のみ import で済むように）
export { EDITOR_WATERMARK_KEYWORDS } from './editor-watermark-keywords'

/**
 * PdfEditorWatermarkFilter（設計書 v1.4.2 §3-9）。
 *
 * PDF 編集ツール（PDFelement / Adobe Acrobat / Foxit 等）の試用版表示が
 * 議事録の項目（field）として誤認識されないよう、fields 候補から除外する。
 *
 * 重要（無加工原則）:
 *   - PDF ファイル本体には絶対に触らない
 *   - WhiteoutPipeline へは送らない
 *   - fields 候補からの除外のみが本フィルタの責務
 *   - 法的リスク（DMCA 1202 / EULA 違反幇助）を最小化する設計
 *
 * 「商用テンプレ販売サイトロゴ検出 → 警告 + ユーザー確認」とは完全に別系統。
 *
 * 入力ソース 3 系統:
 *   - rawText: pdfjs 由来（テキスト PDF）
 *   - ocrResult: Mistral OCR + Tesseract 由来（スキャン PDF / パス B）
 *   - ocrMarkdown: Mistral OCR markdown（§3-5-f 新事実、案 A 検証で
 *     「試用版 PDFelement」が markdown 冒頭で検出可能と確認済）
 */

export type WatermarkDetectionReason =
  | 'keyword_match'
  | 'position_corner_overlay'
  | 'markdown_match'

export interface WatermarkRegion {
  page: number
  bbox: PdfBox
  reason: WatermarkDetectionReason
  matchedKeyword?: string
}

export interface DetectEditorWatermarksInput {
  /** pdfjs 由来（テキスト PDF）の word 単位レイアウト */
  rawText?: RawTextItem[]
  /** Mistral OCR + Tesseract 由来（スキャン PDF / パス B） */
  ocrResult?: ScanOcrResult
  /** ページ寸法（位置パターン判定用、pt 単位） */
  pageSizes: PdfPageSize[]
}

/**
 * テキスト PDF / スキャン PDF どちらでも呼ばれる。
 * 検出されたウォーターマーク領域を fields 抽出時の候補から除外する用途。
 *
 * v1.4.2 §3-9-c の組み込み位置:
 *   TextPdfExtractor / ScanPdfExtractor の後、FieldSemanticExtractor の前。
 *
 * 重要: 戻り値の WatermarkRegion[] は **fields 除外のヒント** のみで、
 * PDF ファイルへの自動加工は行わない。WhiteoutPipeline には絶対渡さない。
 */
export function detectEditorWatermarks(
  input: DetectEditorWatermarksInput,
): WatermarkRegion[] {
  const regions: WatermarkRegion[] = []

  // 1. キーワード一致（テキスト PDF）
  if (input.rawText) {
    for (const item of input.rawText) {
      const matched = pickMatchedKeyword(item.text)
      if (!matched) continue
      regions.push({
        page: item.page,
        bbox: item.bbox,
        reason: 'keyword_match',
        matchedKeyword: matched,
      })
    }
  }

  // 2. キーワード一致（スキャン PDF / パス B）
  if (input.ocrResult) {
    for (const page of input.ocrResult.pages) {
      // ScanOcrResultPage.pageIndex は 0 始まり、アプリ内部 page は 1 始まり
      const page1 = page.pageIndex + 1
      for (const el of page.elements) {
        const matched = pickMatchedKeyword(el.text)
        if (!matched) continue
        regions.push({
          page: page1,
          bbox: el.bbox,
          reason: 'keyword_match',
          matchedKeyword: matched,
        })
      }
    }
  }

  // 3. 位置パターンによる reason 強化（corner overlay）
  //    キーワード一致 + 位置パターン両方該当時のみ reason を 'position_corner_overlay' に
  for (const r of regions) {
    const ps = input.pageSizes.find(p => p.page === r.page)
    if (!ps) continue
    if (isInCornerOverlayRegion(r.bbox, ps)) {
      r.reason = 'position_corner_overlay'
    }
  }

  return regions
}

/**
 * Mistral OCR markdown 文字列のみでキーワード検出する補助関数（§3-5-f 新事実）。
 * 案 A 検証で no-writing.pdf 右上「試用版 PDFelement」が markdown 冒頭 startIndex=0
 * で検出可能と確認済。bbox 情報は持たないため、検出結果は「ページ単位での透かし存在
 * フラグ」として使う（位置による fields 除外は detectEditorWatermarks 経由で別途実施）。
 *
 * 用途: パイプライン上流の早期検知 / ユーザー報告対応時の調査ログ等。
 */
export function detectEditorWatermarksInMarkdown(
  markdown: string,
): Array<{ keyword: string; index: number }> {
  const out: Array<{ keyword: string; index: number }> = []
  for (const k of EDITOR_WATERMARK_KEYWORDS) {
    let from = 0
    while (true) {
      const i = markdown.indexOf(k, from)
      if (i < 0) break
      out.push({ keyword: k, index: i })
      from = i + k.length
    }
  }
  return out
}

/**
 * RawTextItem[] から、検出済 WatermarkRegion と一致する item を除外して返す
 * （テキスト PDF 経路の FieldSemanticExtractor 入力構築用）。
 *
 * 一致判定: ページ番号 + bbox 同一（座標完全一致）。
 */
export function filterOutWatermarkedRawText(
  items: RawTextItem[],
  regions: WatermarkRegion[],
): RawTextItem[] {
  if (regions.length === 0) return items
  const keys = new Set(regions.map(r => boxKey(r.page, r.bbox)))
  return items.filter(i => !keys.has(boxKey(i.page, i.bbox)))
}

/**
 * ScanElement[] から、検出済 WatermarkRegion と一致する要素を除外して返す
 * （スキャン PDF 経路の FieldSemanticExtractor 入力構築用）。
 *
 * 一致判定: ページ番号 + bbox 同一（座標完全一致）。
 * ScanElement.page は ScanOcrResultPage.pageIndex 由来（0-based）なので
 * +1 してアプリ内部 page と揃える。
 */
export function filterOutWatermarkedScanElements(
  ocrResult: ScanOcrResult,
  regions: WatermarkRegion[],
): ScanOcrResult {
  if (regions.length === 0) return ocrResult
  const keys = new Set(regions.map(r => boxKey(r.page, r.bbox)))
  return {
    pages: ocrResult.pages.map(p => {
      const page1 = p.pageIndex + 1
      const filtered: ScanElement[] = p.elements.filter(
        e => !keys.has(boxKey(page1, e.bbox)),
      )
      return { ...p, elements: filtered }
    }),
  }
}

// =============================================================================
// 内部ヘルパー
// =============================================================================

function pickMatchedKeyword(text: string): string | undefined {
  const t = text.trim()
  if (t.length === 0) return undefined
  return EDITOR_WATERMARK_KEYWORDS.find(k => t.includes(k))
}

function isInCornerOverlayRegion(bbox: PdfBox, pageSize: PdfPageSize): boolean {
  const cx = bbox.x + bbox.w / 2
  const cy = bbox.y + bbox.h / 2
  // 右上 corner: x が 60% 以上 + y が上端 10% 以内
  const isTopRight = cx > pageSize.width * 0.6 && cy < pageSize.height * 0.1
  // 右下 corner: x が 60% 以上 + y が下端 15% 以内
  const isBottomRight = cx > pageSize.width * 0.6 && cy > pageSize.height * 0.85
  return isTopRight || isBottomRight
}

function boxKey(page: number, bbox: PdfBox): string {
  return `${page}:${bbox.x}:${bbox.y}:${bbox.w}:${bbox.h}`
}
