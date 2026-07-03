import type { ScanOcrResult } from './scan-extractor'
import type { LayoutCluster } from './layout-cluster'
import type { CellClassification, CellRole } from './whiteout-role-classifier'
import { type WhiteoutBox, DEFAULT_BG_COLOR_WHITE } from './whiteout-types'

/**
 * WhiteoutPipeline — 書込済 PDF を白塗り化するパス B 実装（ユーザー矩形ドラッグ UI 主導）。
 *
 * 構成:
 *   - suggestWhiteoutCandidates: ScanOcrResult から「白塗り候補サジェスト」を返す（補助、品質保証外）
 *   - applyWhiteout: ユーザー確定済の WhiteoutBox[] を pdf-lib drawRectangle で塗り、新 PDF 返却
 *
 * 実装ノート:
 *   - 背景色推定は白固定（#FFFFFF）。
 *   - pdf-lib は Edge Runtime 不可 → Node.js Runtime 限定
 *   - PDF 座標系（左下原点）変換に注意（drawRectangle の y は左下原点で指定）
 *
 * PdfEditorWatermarkFilter の検出領域は本 Pipeline に渡さない（PDF 編集ツール透かしは無加工保持）。
 */

/**
 * pdf-lib のページ抽象を構造的ダックタイピングで受ける（型 import を遅延させ
 * Edge Runtime バンドルから切り離す。実体は PDFPage）。
 */
interface PdfPageLike {
  getHeight(): number
  drawRectangle(opts: {
    x: number
    y: number
    width: number
    height: number
    color: { red: number; green: number; blue: number }
    borderWidth?: number
  }): void
}

interface PdfDocumentLike {
  getPages(): PdfPageLike[]
  save(): Promise<Uint8Array>
}

/**
 * Buffer / Uint8Array を入力に取り、WhiteoutBox[] を pdf-lib drawRectangle で
 * 塗り、新 PDF Buffer を返す。
 *
 * @param pdfBytes  原本 PDF のバイト列
 * @param boxes     ユーザー確定済の白塗り対象矩形
 * @returns         白塗り適用後の PDF バイト列（新 PDF Buffer）
 */
export async function applyWhiteout(
  pdfBytes: Uint8Array,
  boxes: WhiteoutBox[],
): Promise<Uint8Array> {
  const { PDFDocument, rgb } = await import('pdf-lib')
  const pdf = (await PDFDocument.load(pdfBytes)) as unknown as PdfDocumentLike
  const pages = pdf.getPages()

  for (const box of boxes) {
    const pageIndex = box.page - 1  // 1-based → 0-based
    if (pageIndex < 0 || pageIndex >= pages.length) {
      continue  // 範囲外は安全に skip（unit test でカバー）
    }
    const page = pages[pageIndex]
    const pageHeight = page.getHeight()
    page.drawRectangle({
      // 左上原点 → pdf-lib（左下原点）に変換
      x: box.bbox.x,
      y: pageHeight - box.bbox.y - box.bbox.h,
      width: box.bbox.w,
      height: box.bbox.h,
      color: rgb(
        box.estimatedBgColor.r / 255,
        box.estimatedBgColor.g / 255,
        box.estimatedBgColor.b / 255,
      ),
      borderWidth: 0,
    })
  }

  // useObjectStreams:true（既定）だと再シリアライズでスキャン画像 XObject の格納/参照
  // 表現が変わり、pdfjs → @napi-rs/canvas の画像描画が落ちる。useObjectStreams:false
  // （xref table 形式＝元 PDF 相当）で napi-rs/canvas 互換を確保する。
  return await (
    pdf as unknown as {
      save(opts: { useObjectStreams: boolean }): Promise<Uint8Array>
    }
  ).save({ useObjectStreams: false })
}

/**
 * パス B 白塗り候補の自動サジェスト（補助、品質保証外）。
 *
 * ScanOcrResult の elements から手書き想定 word を抽出し、ユーザーが矩形を 1 個 1 個
 * ドラッグする手間を減らす補助情報として WhiteoutBox[] を返す。
 * 厳密な手書き判定ではなく、Tesseract.js confidence < 70 を手書き想定として代用する。
 * UI 側でユーザーは「サジェスト採用 / 削除 / 全部無視」を自由選択可。
 */
export function suggestWhiteoutCandidates(ocr: ScanOcrResult): WhiteoutBox[] {
  const boxes: WhiteoutBox[] = []
  for (const page of ocr.pages) {
    for (const el of page.elements) {
      if (el.type === 'handwriting') {
        boxes.push({
          // ScanOcrResult.pageIndex は 0-based、WhiteoutBox.page は 1-based
          page: page.pageIndex + 1,
          bbox: el.bbox,
          estimatedBgColor: DEFAULT_BG_COLOR_WHITE,
          source: 'auto_suggestion',
        })
      }
    }
  }
  return boxes
}

/**
 * LayoutCluster（行列マトリクス）+ Claude role 判定結果から白塗り候補を返す。
 * confidence<70 の機械的 handwriting 判定（誤検出源）を使わず、role で対象を決める。
 *
 * 白塗り対象 = role==='value_or_entry' のセルのみ（デフォルト）。
 *   - 'label'（項目名ラベル）/ 'printed_static'（タイトル等）/ 'noise' は塗らない。
 *   - bbox は Claude でなく前処理クラスタ実測を採用（座標非介入）。
 *
 * @param cluster          buildLayoutCluster の出力
 * @param classifications  classifyCellRoles の出力（cellId → role）
 * @param targetRoles      白塗り対象とする role 集合（既定 value_or_entry のみ）
 */
export function suggestWhiteoutCandidatesByRole(
  cluster: LayoutCluster,
  classifications: CellClassification[],
  targetRoles: CellRole[] = ['value_or_entry'],
): WhiteoutBox[] {
  const targetSet = new Set(targetRoles)
  const roleByCellId = new Map(classifications.map(c => [c.cellId, c.role]))
  const boxes: WhiteoutBox[] = []
  for (const page of cluster.pages) {
    for (const cell of page.cells) {
      const role = roleByCellId.get(cell.cellId)
      if (role && targetSet.has(role)) {
        boxes.push({
          page: cell.page, // LayoutCell.page は 1-based
          bbox: cell.bbox,
          estimatedBgColor: DEFAULT_BG_COLOR_WHITE,
          source: 'auto_suggestion',
        })
      }
    }
  }
  return boxes
}

export type { RgbColor, WhiteoutSource, WhiteoutBox } from './whiteout-types'
export { DEFAULT_BG_COLOR_WHITE } from './whiteout-types'
export { suggestWhiteoutCandidatesByField } from './whiteout-field-suggest'
export type { FieldSuggestDiag } from './whiteout-field-suggest'
