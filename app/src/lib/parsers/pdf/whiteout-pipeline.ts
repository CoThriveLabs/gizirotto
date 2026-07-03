import type { PdfBox } from './pdf-types'
import type { ScanOcrResult } from './scan-extractor'
import type { LayoutCluster, LayoutCell } from './layout-cluster'
import type { CellClassification, CellRole } from './whiteout-role-classifier'
import {
  type FieldBox,
  type RasterPagePixels,
  LEFT_LABEL_COL_MAX_W_RATIO,
} from './field-bbox-detector'
import {
  INSET_LEFT_PT,
  INSET_RIGHT_PT,
  INSET_TOP_PT,
  INSET_BOTTOM_PT,
  LABEL_FIELD_AREA_MAX_RATIO,
  FULLWIDTH_BAND_RATIO,
  POS_LABEL_MAX_W_RATIO,
  BAND_GROUP_GAP_PT,
  INK_LUMA_DELTA,
  INK_MIN_DENSITY,
  INK_BORDER_MARGIN_PX,
  INK_SCAN_STEP,
  MIN_INK_SCAN_PX,
  BAND_RANGE_SPLIT_GAP_PT,
  LINE_OVERLAP_FIX_PX,
  LABEL_COLHIST_ZERO_MAX,
  VLINE_RESIDUE_RUN_RATIO,
  INK_MIN_COMPONENT,
} from './whiteout-constants'
import { logExcludeLabel, logInkCell, logInkDist, logInkName, fmtBox } from './whiteout-diag'

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

export interface RgbColor {
  r: number
  g: number
  b: number
}

export const DEFAULT_BG_COLOR_WHITE: RgbColor = { r: 255, g: 255, b: 255 }

/**
 * source の意味:
 *   - 'auto_suggestion': 自動検出された白塗り候補（補助、品質保証外）
 *   - 'manual': ユーザー UI で確定された矩形（採用判定 or ドラッグ追加）
 */
export type WhiteoutSource = 'auto_suggestion' | 'manual'

export interface WhiteoutBox {
  /** ページ番号（1 始まり、アプリ内部表現）*/
  page: number
  /** 白塗り対象の矩形（左上原点・pt 単位、PdfBox 共通） */
  bbox: PdfBox
  /** 推定背景色（v1 既定: 白）*/
  estimatedBgColor: RgbColor
  /** source。'auto_suggestion' = サジェスト / 'manual' = ユーザー確定 */
  source: WhiteoutSource
}

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

/**
 * inset。矩形を内側に縮める → 外周・セル境界の罫線を残す。
 * 全辺を独立 const にして調整可能（左右同値 / 上下同値の運用）。エリアA/B 共通通過。
 * 過小側に倒れるよう w/h は 0 下限でクランプする（clamped=true を診断に出す）。
 */
function insetBox(b: PdfBox): { bbox: PdfBox; clamped: boolean } {
  const w = b.w - INSET_LEFT_PT - INSET_RIGHT_PT
  const h = b.h - INSET_TOP_PT - INSET_BOTTOM_PT
  return {
    bbox: {
      x: b.x + INSET_LEFT_PT,
      y: b.y + INSET_TOP_PT,
      w: Math.max(0, w),
      h: Math.max(0, h),
    },
    clamped: w <= 0 || h <= 0,
  }
}

/**
 * v0.8 §2-2 / v0.8.2 §11-4: hasInkInCell の結果（診断ログ用に内訳実値を保持）。
 *
 * v0.8.2 で配線拡張（§11-4）: 端列縦ラン控除後の実効 ink（③-B-1）/ インク列分布 colHist（②難所A §3-A）/
 * 最大連結成分 maxComponent（散在ノイズ排除 §3-B-1/P4）を判定経路で使うため戻り値に同梱する。
 * 既存 pixels を共有し再デコード 0・走査 1 回で全量を算出（コスト最小・新規依存 0）。
 * 🚨 colHist/edgeVRun/maxComponent は前景インク画素の空間分布の幾何（地色不使用・§0-A）。
 */
export interface InkResult {
  /**
   * 記入ありか。v0.8.2: 端列縦ラン控除後の実効 inkRatio が INK_MIN_DENSITY 以上 **かつ**
   * maxComponent >= INK_MIN_COMPONENT（散在ノイズでない）の AND（§3-B-1）。
   */
  hasInk: boolean
  /** 走査領域に占める実効インク画素比（v0.8.2: 端列縦ラン控除後）。 */
  inkRatio: number
  /** 局所背景 luma（セル内最頻値）。診断観測用。判定には絶対値を使わない（§0-A）。 */
  bgLuma: number
  /**
   * v0.8.2 §3-A: 記入欄左セル vs ラベルの分散度判定（isPositionalLabelInRange）に渡す 8 分割列ヒストグラム。
   * 🚨 **端列縦ラン控除の前（raw）の前景インク列分布**を使う（§3-A は「前景の列分布」で②、§3-B-1 は
   * 「density 控除」で③＝別目的）。控除後を②に使うと、端罫線が乗っていた記入欄セルで端列がゼロ化
   * → ゼロ列数増 → 偏在誤判定で記入欄が消える副作用が出るため、②には必ず raw を使う。
   */
  colHist: number[]
  /** v0.8.2 §8 診断用: 端列縦ラン控除「後」の 8 分割列ヒストグラム（③の効きを観測。判定には不使用）。 */
  colHistAfterEdgeCut: number[]
  /** v0.8.2 §3-B-1/P4: 最大連結成分サイズ（走査サンプル空間・端列縦ラン控除後。散在ノイズ排除）。 */
  maxComponent: number
  /** v0.8.2 §3-B-1: 端列縦フルランとして控除した画素数（罫線残り。診断用）。 */
  edgeVRun: number
  /** v0.8.2 §8 診断用: 控除前の生インク画素数（走査サンプル空間）。 */
  rawInkPixels: number
}

/** hasInkInCell が走査サンプル空間で使う 8 分割ヒストグラムのビン数（colHist の長さ）。 */
const INK_COLHIST_BINS = 8

/**
 * v0.8 §2-2 核心 / v0.8.2 §3-B-1。セル内の「記入インク（前景ピクセル）有無」を判定する（OCR非依存・背景色非依存）。
 *
 * 🚨 背景色非依存の担保:
 *   背景 luma は「セル内最頻値」を**相対基準**として使うだけで、その絶対値（白≈255/グレー≈210）で
 *   塗る塗らないを決めない。「背景より INK_LUMA_DELTA 以上濃い前景があるか」だけを見る。地色がグレーの
 *   ヘッダー帯でもインクが無ければ inkRatio≈0 → 記入なし（地色がグレーだから塗る、はしない）。
 *   colHist / 端列縦ラン控除 / maxComponent も前景インク画素の空間分布の幾何のみ（地色不使用）。
 *
 * v0.8.2 の判定強化（§3-B-1・背景色非依存厳守）:
 *   - 端列縦ラン控除（縦罫線残り除去）: 端列（最左 col0 / 最右 col最終）の縦連続ランが走査高の
 *     VLINE_RESIDUE_RUN_RATIO 以上なら「縦罫線残り」とみなし、その端列のインク画素を控除して
 *     実効 ink（effectiveInk）で density 評価する（部署空欄の左右縦罫線が落ちる）。
 *   - maxComponent AND: 最大連結成分が INK_MIN_COMPONENT 以上のときのみ記入とみなす（散在ノイズ＝
 *     添付ヘッダー等の極小成分を落とす）。罫線（大成分）は端列縦ラン控除で、散在は maxComponent で二経路除去。
 *   - colHist（8 分割列ヒストグラム）を戻り値に同梱（記入欄左セル vs ラベルの分散度判定用・§3-A）。
 *
 * @param data        RGBA バイト列（detectFieldBboxes が共有する画素・再デコード不要）
 * @param pixelWidth  画像幅 px
 * @param cellPx      セルの px 矩形（x0,y0,x1,y1。pt→px 逆算済み）
 */
function hasInkInCell(
  data: Uint8ClampedArray | Uint8Array,
  pixelWidth: number,
  pixelHeight: number,
  cellPx: { x0: number; y0: number; x1: number; y1: number },
): InkResult {
  const empty: InkResult = {
    hasInk: false,
    inkRatio: 0,
    bgLuma: 255,
    colHist: new Array(INK_COLHIST_BINS).fill(0),
    colHistAfterEdgeCut: new Array(INK_COLHIST_BINS).fill(0),
    maxComponent: 0,
    edgeVRun: 0,
    rawInkPixels: 0,
  }

  // 1) 罫線厚ぶん内側へ（INK_BORDER_MARGIN_PX）。罫線（黒）をインクと数えない。
  //    画像範囲も超えないようクランプ（負 index / 範囲外アクセス防止）。
  const x0 = Math.max(0, Math.round(cellPx.x0) + INK_BORDER_MARGIN_PX)
  const y0 = Math.max(0, Math.round(cellPx.y0) + INK_BORDER_MARGIN_PX)
  const x1 = Math.min(pixelWidth, Math.round(cellPx.x1) - INK_BORDER_MARGIN_PX)
  const y1 = Math.min(pixelHeight, Math.round(cellPx.y1) - INK_BORDER_MARGIN_PX)
  if (x1 - x0 < MIN_INK_SCAN_PX || y1 - y0 < MIN_INK_SCAN_PX) {
    return empty
  }

  // 2) 走査領域の luma ヒストグラム（検出側と同じ整数 luma 近似）。間引き INK_SCAN_STEP。
  //    背景 luma（最頻値・相対基準）を決めるための第 1 パス。
  const step = INK_SCAN_STEP > 0 ? INK_SCAN_STEP : 1
  const hist = new Int32Array(256)
  let total = 0
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * pixelWidth + x) * 4
      const luma = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8
      hist[luma]++
      total++
    }
  }
  if (total === 0) return empty

  // 背景 luma = 最頻値（セルの地色。絶対値で白/グレー分類しない＝厳命①遵守・相対基準としてのみ使う）。
  let bgLuma = 0
  let bgCount = -1
  for (let l = 0; l < 256; l++) {
    if (hist[l] > bgCount) {
      bgCount = hist[l]
      bgLuma = l
    }
  }

  // 3) インクビットマップ（走査サンプル空間）を作る。インク = 「背景より INK_LUMA_DELTA 以上濃い
  //    （luma が小さい）」画素（局所相対・地色絶対値は不問）。空間分布（端列縦ラン / colHist /
  //    連結成分）を取るためビットマップ化する（§3-B-1）。
  const cols = Math.max(1, Math.ceil((x1 - x0) / step))
  const rows = Math.max(1, Math.ceil((y1 - y0) / step))
  const inkMap = new Uint8Array(cols * rows)
  const inkLumaMax = bgLuma - INK_LUMA_DELTA
  let rawInk = 0
  let ci = 0
  for (let y = y0; y < y1; y += step, ci++) {
    let cj = 0
    for (let x = x0; x < x1; x += step, cj++) {
      const i = (y * pixelWidth + x) * 4
      const luma = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8
      if (luma <= inkLumaMax) {
        inkMap[ci * cols + cj] = 1
        rawInk++
      }
    }
  }

  // §3-A 用 colHist（raw = 端列縦ラン控除の「前」の前景インク列分布）。記入欄左セル vs ラベルの分散度判定に
  // 使う（控除後を使うと端罫線が乗っていた記入欄セルが偏在誤判定で消えるため、②には必ず raw を使う）。
  const colHistRaw = colHistFromInkMap(inkMap, cols, rows)

  // 4) §3-B-1 端列縦ラン控除（縦罫線残り除去）。「端列に集中した縦罫線」を罫線とみなし控除する。
  //    端（最左 / 最右）から内側へ向かって、各列の縦連続ランが走査高 rows の VLINE_RESIDUE_RUN_RATIO
  //    以上（縦フルラン）である限り罫線として控除し、フルランでない列が現れた時点で停止する。
  //    こうすることで、罫線が走査サンプル空間で複数列に広がっても（実機の罫線は数 px 幅）端の罫線塊を
  //    まとめて控除でき、かつ端から連続フルランが途切れた時点で止まるので **中央の記入には届かない**
  //    （記入文字は縦に数 px で途切れる＝フルランにならないので残る・氏名両立 §3-B / 撤退条件 §7）。
  //    🚨 端列＋縦フルランは前景の幾何（地色不使用・§0-A）。新 const は増やさない（端からの連続で定義）。
  const vRunThr = rows * VLINE_RESIDUE_RUN_RATIO
  let edgeVRun = 0
  // 1 列の縦最長連続ランとインク数を返す内部関数。
  const colVRunInfo = (c: number): { maxRun: number; colInk: number } => {
    let run = 0
    let maxRun = 0
    let colInk = 0
    for (let r = 0; r < rows; r++) {
      if (inkMap[r * cols + c]) {
        run++
        colInk++
        if (run > maxRun) maxRun = run
      } else {
        run = 0
      }
    }
    return { maxRun, colInk }
  }
  const cutColumn = (c: number, colInk: number): void => {
    edgeVRun += colInk
    for (let r = 0; r < rows; r++) inkMap[r * cols + c] = 0
  }
  // 左端から内側へ：縦フルランが続く限り控除（罫線塊）。途切れたら停止（中央の記入を守る）。
  for (let c = 0; c < cols; c++) {
    const { maxRun, colInk } = colVRunInfo(c)
    if (maxRun >= vRunThr) cutColumn(c, colInk)
    else break
  }
  // 右端から内側へ：同様（左端の控除済み列に達したら自然に止まる＝重複控除しない）。
  for (let c = cols - 1; c >= 0; c--) {
    const { maxRun, colInk } = colVRunInfo(c)
    if (maxRun >= vRunThr) cutColumn(c, colInk)
    else break
  }

  const effectiveInk = rawInk - edgeVRun
  const inkRatio = effectiveInk / total

  // 5) 端列縦ラン控除「後」の colHist（診断観測用・③の効きを見る。判定には使わない）。
  const colHistAfter = colHistFromInkMap(inkMap, cols, rows)

  // 6) §3-B-1/P4 最大連結成分（4 近傍・反復スタック）。散在ノイズ（小成分）と記入（大成分）を分離。
  //    端列縦ラン控除「後」の inkMap で評価する（控除した罫線塊が大成分として残らないように）。
  const maxComponent = computeMaxComponent(inkMap, cols, rows)

  // 7) 判定（§3-B-1）: 実効密度 AND まとまり。罫線残りを控除した実効 ink が密度を満たし、かつ
  //    最大成分が散在ノイズでない（INK_MIN_COMPONENT 以上）ときのみ記入あり。
  const hasInk = inkRatio >= INK_MIN_DENSITY && maxComponent >= INK_MIN_COMPONENT

  return {
    hasInk,
    inkRatio,
    bgLuma,
    colHist: colHistRaw, // §3-A は raw（控除前）の列分布で②を判定。
    colHistAfterEdgeCut: colHistAfter,
    maxComponent,
    edgeVRun,
    rawInkPixels: rawInk,
  }
}

/**
 * v0.8.2: インクビットマップ（走査サンプル空間）の 8 分割列ヒストグラム（colHist）を返す。
 * raw（控除前）/ after（控除後）の両方を同じロジックで作るための共通ヘルパー。前景画素の列分布のみ（§0-A）。
 */
function colHistFromInkMap(inkMap: Uint8Array, cols: number, rows: number): number[] {
  const hist = new Array<number>(INK_COLHIST_BINS).fill(0)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!inkMap[r * cols + c]) continue
      const bin = Math.min(INK_COLHIST_BINS - 1, ((c * INK_COLHIST_BINS) / cols) | 0)
      hist[bin]++
    }
  }
  return hist
}

/**
 * v0.8.2 §3-B-1/P4。インクビットマップ（走査サンプル空間）の最大連結成分サイズ（4 近傍）を返す。
 * 反復スタックで再帰なし（深いセルでもスタックオーバーフローしない）。散在ノイズ（小成分多数）と
 * 記入文字（大きな塊）を分離するために使う。前景画素の幾何のみ（地色不使用・§0-A）。
 */
function computeMaxComponent(inkMap: Uint8Array, cols: number, rows: number): number {
  const visited = new Uint8Array(cols * rows)
  const stack: number[] = []
  let maxComponent = 0
  for (let s = 0; s < cols * rows; s++) {
    if (!inkMap[s] || visited[s]) continue
    let size = 0
    stack.length = 0
    stack.push(s)
    visited[s] = 1
    while (stack.length > 0) {
      const idx = stack.pop() as number
      size++
      const r = (idx / cols) | 0
      const c = idx - r * cols
      if (c + 1 < cols) {
        const n = idx + 1
        if (inkMap[n] && !visited[n]) { visited[n] = 1; stack.push(n) }
      }
      if (c - 1 >= 0) {
        const n = idx - 1
        if (inkMap[n] && !visited[n]) { visited[n] = 1; stack.push(n) }
      }
      if (r + 1 < rows) {
        const n = idx + cols
        if (inkMap[n] && !visited[n]) { visited[n] = 1; stack.push(n) }
      }
      if (r - 1 >= 0) {
        const n = idx - cols
        if (inkMap[n] && !visited[n]) { visited[n] = 1; stack.push(n) }
      }
    }
    if (size > maxComponent) maxComponent = size
  }
  return maxComponent
}

/**
 * v0.8: field bbox（pt・左上原点）→ px 矩形へ逆算し hasInkInCell を呼ぶ薄いラッパ。
 * 画素が無い（後方互換・テスト無指定）場合は判定不能として hasInk=false を返す。
 */
function fieldHasInk(
  fieldBbox: PdfBox,
  pixels: RasterPagePixels | undefined,
): InkResult {
  if (!pixels) {
    return {
      hasInk: false,
      inkRatio: 0,
      bgLuma: 255,
      colHist: new Array(INK_COLHIST_BINS).fill(0),
      colHistAfterEdgeCut: new Array(INK_COLHIST_BINS).fill(0),
      maxComponent: 0,
      edgeVRun: 0,
      rawInkPixels: 0,
    }
  }
  // pt → px（detectFieldBboxesFromImageData の sx=pageWidthPt/pixelWidth の逆）。
  const pxPerPtX = pixels.pixelWidth / pixels.pageWidthPt
  const pxPerPtY = pixels.pixelHeight / pixels.pageHeightPt
  return hasInkInCell(pixels.data, pixels.pixelWidth, pixels.pixelHeight, {
    x0: fieldBbox.x * pxPerPtX,
    y0: fieldBbox.y * pxPerPtY,
    x1: (fieldBbox.x + fieldBbox.w) * pxPerPtX,
    y1: (fieldBbox.y + fieldBbox.h) * pxPerPtY,
  })
}

// v0.8: 記入有無は OCR written overlap ではなく hasInkInCell（インク前景検出）で判定する（真因＝OCR漏れ）。
// 旧 writtenOverlapBest / hasWrittenOverlap / OverlapBest は塗り判定から外れたため削除した
// （OCR 呼び出し自体は scan-extractor 側で温存・§6。pipeline 内の overlap ヘルパーは v0.8 で役目を終えた）。

/**
 * §5-2 3 重ラベル判定。OR でいずれか当たればラベルセル = 塗らない。
 *   (1) role==='label'（Claude 判定）
 *   (3) labelLexiconHit（語彙、OCR 崩れに保険）
 *   (2) 行内最左 かつ 幅 ≤ ページ幅 * LEFT_LABEL_COL_MAX_W_RATIO（位置、OCR text 非依存）
 * 背景色（薄背景ラベルセル）は一切参照しない（指示①厳守）。
 */
function isLabelCell(
  cell: LayoutCell,
  role: CellRole | undefined,
  pageWidthPt: number,
): boolean {
  if (role === 'label') return true
  if (cell.labelLexiconHit) return true
  if (cell.isLeftmostInRow && cell.bbox.w <= pageWidthPt * LEFT_LABEL_COL_MAX_W_RATIO) {
    return true
  }
  return false
}

/** ラベルセル（中心 + セル bbox）。v0.7.3 で面積比判定のため cellBbox も保持する。 */
interface LabelCenter {
  cx: number
  cy: number
  cellBbox: PdfBox
}

/** §3-1 課題① の判定内訳（診断ログ用）。どの理由で残ったか / 除外されたかを実値で示す。 */
export interface FieldLabelDecision {
  isLabel: boolean
  /** 内包しているラベルセル（あれば）。診断用。 */
  hit?: LabelCenter
  /** 除外/残留の判定根拠。 */
  reason: 'areaB-guard' | 'no-contain' | 'byAreaRatio' | 'byFullwidth' | 'kept-large'
  labelArea?: number
  fieldArea?: number
  ratio?: number
}

/**
 * v0.7.3 §3-1 課題①。「field がラベルを内包」→「field 自体がラベルセル（ほぼ一致）」に変更。
 *
 * ラベル除外の本来意図は「field bbox 自体がラベルセル（塗ってはいけない項目名欄）」を弾くこと。
 * 大枠（議事内容）が中の番号ラベルを内包するのは正常 → 除外しない。2 条件の AND ゲート:
 *   (A) field がラベル中心を内包する
 *   AND (B) field がそのラベルセルと「ほぼ一致」（面積比 <= LABEL_FIELD_AREA_MAX_RATIO）
 *        または 全幅 1 行薄帯（FULLWIDTH_BAND_RATIO 以上幅 × 1 行高以下）
 * エリアB（外周罫線大枠）は定義上ラベルセルになり得ないので無条件で除外対象外。
 * 背景色は一切参照しない（指示①厳守）。
 */
function decideFieldItselfLabel(
  fb: FieldBox,
  labelCenters: LabelCenter[],
  pageWidthPt: number,
): FieldLabelDecision {
  // 大枠ガード: エリアB は無条件で「field 自体がラベル」ではない
  if (fb.area === 'B') return { isLabel: false, reason: 'areaB-guard' }

  let lastHit: LabelCenter | undefined
  let lastLabelArea = 0
  let lastFieldArea = 0
  let lastRatio = 0
  for (const lc of labelCenters) {
    // (A) field がラベル中心を内包
    const contains =
      lc.cx >= fb.bbox.x &&
      lc.cx <= fb.bbox.x + fb.bbox.w &&
      lc.cy >= fb.bbox.y &&
      lc.cy <= fb.bbox.y + fb.bbox.h
    if (!contains) continue

    const fieldArea = fb.bbox.w * fb.bbox.h
    const labelArea = Math.max(1, lc.cellBbox.w * lc.cellBbox.h)
    const ratio = fieldArea / labelArea
    lastHit = lc
    lastLabelArea = labelArea
    lastFieldArea = fieldArea
    lastRatio = ratio

    // (B) ほぼ一致（面積比）: field がラベルセルの LABEL_FIELD_AREA_MAX_RATIO 倍以内
    if (fieldArea <= labelArea * LABEL_FIELD_AREA_MAX_RATIO) {
      return {
        isLabel: true,
        hit: lc,
        reason: 'byAreaRatio',
        labelArea,
        fieldArea,
        ratio,
      }
    }

    // 補助: 全幅 1 行帯（薄いラベル帯）は面積比に関わらず除外維持
    const isFullWidthThinBand =
      fb.bbox.w >= pageWidthPt * FULLWIDTH_BAND_RATIO &&
      fb.bbox.h <= lc.cellBbox.h * 1.5
    if (isFullWidthThinBand) {
      return {
        isLabel: true,
        hit: lc,
        reason: 'byFullwidth',
        labelArea,
        fieldArea,
        ratio,
      }
    }
  }

  if (lastHit) {
    // 内包しているが面積比/全幅帯のどちらにも当たらない = 大枠として残す
    return {
      isLabel: false,
      hit: lastHit,
      reason: 'kept-large',
      labelArea: lastLabelArea,
      fieldArea: lastFieldArea,
      ratio: lastRatio,
    }
  }
  return { isLabel: false, reason: 'no-contain' }
}

function isFieldItselfLabel(
  fb: FieldBox,
  labelCenters: LabelCenter[],
  pageWidthPt: number,
): boolean {
  return decideFieldItselfLabel(fb, labelCenters, pageWidthPt).isLabel
}

/**
 * v0.7.4 §3-1 残①。位置ベース直接ラベル除外（OCR 非依存）。
 * 罫線 field box の幾何だけで「帯内最左 AND 幅狭」をラベル列とみなす。
 *
 * cluster 経由ラベル除外（isFieldItselfLabel）は OCR が読めたラベルにしか効かない。
 * 「日時/場所/出席者」が OCR で読めず cluster にラベルセル不在のとき、罫線 field の
 * 最左狭セルが除外漏れで塗られる真因①を、この位置除外で塞ぐ。
 *
 * 背景色は一切参照せず、field box の x/w（罫線座標）のみ（指示①厳守）。
 * 誤爆しない線引き: 「最左 AND 幅狭」の AND。記入欄本体（広い or 最左でない）は除外されない。
 */
function isPositionalLabel(
  fb: FieldBox,
  bandLeftMostX: number,
  pageWidthPt: number,
): boolean {
  const isLeftMost = Math.abs(fb.bbox.x - bandLeftMostX) < 1e-3
  const isNarrow = fb.bbox.w <= pageWidthPt * POS_LABEL_MAX_W_RATIO
  return isLeftMost && isNarrow
}

/**
 * v0.8.1 §3-P1② / v0.8.2 §3-A（難所A）。項目区画（range）ローカルの最左ラベル除外。
 *
 * 真因②（v0.8 §1）: 「氏名」ラベル(x=342)が帯内グローバル最左(x=65)でないため isPositionalLabel
 * で除外漏れ → インク（印字）を記入と拾い誤塗り。本関数は §3-P1① で横並び分割した各 range の
 * 最左狭セルをラベル候補にする（帯内グローバル最左だけでなく各項目区画ローカルの最左も対象）。
 *
 * 🚨 v0.8.2 難所A（§3-A）: 幅だけでは「場所記入左(w73 分散)」と「氏名ラベル(w39 端偏在)」を分離
 * できない（両方とも narrow）。インク列分布の **分散度** を併用して区別する:
 *   - ラベル印字 = 列分布が端に偏在（colHist のゼロ列が LABEL_COLHIST_ZERO_MAX 以上）→ 除外する
 *   - 記入文字   = 列分布が全列に分散（ゼロ列が少ない）→ 除外しない（記入欄として残す）
 *   実機 ink-dist: 氏名ラベル colHist=[0,0,0,9,32,47,44,43] ゼロ 3 列 → 除外 /
 *   場所記入左 colHist=[32,45,37,53,47,26,35,97] ゼロ 0 列 → 残す。
 *
 * 🚨 背景色非依存（§0-A 最デリケート箇所・厳命①）: 判定軸は位置（range 最左か）+ 幅（狭いか）+
 * インク列分布の分散度（colHist）のみで、地色（bgLuma）の絶対値は一切見ない。colHist は前景インク
 * 画素の列分布（地色不使用）。氏名ラベルを「グレーだから」では除外しない＝過去却下のグレー帯検出と異なる。
 *
 * @param fb              判定対象セル
 * @param rangeLeftMostX  そのセルが属する range（横並び分割後の項目区画）の最左セルの x
 * @param pageWidthPt     ページ幅 pt（幅狭判定の基準）
 * @param colHist         （任意）そのセルの前景インク 8 分割列ヒストグラム。未供給なら従来どおり
 *                        位置+幅のみで判定（後方互換）。
 */
function isPositionalLabelInRange(
  fb: FieldBox,
  rangeLeftMostX: number,
  pageWidthPt: number,
  colHist?: number[],
): boolean {
  const isLeftMost = Math.abs(fb.bbox.x - rangeLeftMostX) < 1e-3
  const isNarrow = fb.bbox.w <= pageWidthPt * POS_LABEL_MAX_W_RATIO
  if (!isLeftMost || !isNarrow) return false
  // インク列分布が無い（colHist 未供給）なら従来どおり位置+幅で判定（後方互換）。
  if (!colHist) return true
  // §3-A 偏在度: ゼロ列数で分散/偏在を判定。記入文字は分散（ゼロ列 < LABEL_COLHIST_ZERO_MAX）。
  const zeroCols = colHist.filter(v => v === 0).length
  const isConcentrated = zeroCols >= LABEL_COLHIST_ZERO_MAX // 例 8 列中 >=3 がゼロ＝偏在＝ラベル
  return isConcentrated // 分散（記入文字）なら false＝除外しない
}

/**
 * v0.8.2 §3-A: インクありセルと、その前景インク列分布（colHist）のペア。
 * range 最左ラベル除外（isPositionalLabelInRange）で colHist の分散度を使うため、(2) のインク判定で
 * 得た colHist をセルに紐付けて range ループへ運ぶ（再走査しない＝コスト最小・§11-4 配線）。
 */
interface InkCell {
  cell: FieldBox
  colHist: number[]
}

/** 帯内束ねの 1 件分（診断ログ用に束ね内訳を保持）。 */
interface BandMerge {
  /** 束ね後の矩形（inset 前の field 座標）。 */
  bbox: PdfBox
  /** 束ねに使った帯の top（y）。 */
  bandTop: number
  /** 帯内のエリアA セル総数。 */
  cellsIn: number
  /** cluster 経由ラベルで除外されたセル数。 */
  labelCut: number
  /** 位置ラベル（最左狭セル）で除外されたセル数（残① + v0.8.1 range 最左）。 */
  posLabelCut: number
  /** v0.8: インク無し細セル数（レンジ束ねでは端の判定にのみ使い切らない）。 */
  emptyCut: number
  /** v0.8: 束ねに使ったインクありセル数。 */
  inkCells: number
  /** v0.7.5 §3-B / v0.8: 記入（インク）が実在する最左セルの左端（クランプ前）。 */
  writtenLeft: number
  /** v0.7.5 §3-B / v0.8: 記入（インク）が実在する最右セルの右端。 */
  writtenRight: number
  /** v0.7.5 §3-A: 除外したラベル列の右端（左端クランプ基準）。 */
  labelRight: number
  /** v0.8.1 §3-P1①: この帯が横並び分割で何 range に割れたか（診断 ranges=）。 */
  rangeCount: number
  /** v0.8.1 §3-P1①: この range が帯内の何番目か（0 始まり。診断 split=）。 */
  rangeIndex: number
}

/**
 * v0.8.1: mergeInkCellsInBand の帯単位サマリ（複数 range にまたがる除外カウントを 1 回だけ集計）。
 * 各 BandMerge にコピーすると range 重複で二重計上になるため、帯全体のカウントはここに集約する。
 */
interface BandSummary {
  /** cluster 経由ラベルで除外されたセル数（帯全体）。 */
  labelCut: number
  /** 位置ラベル（帯内グローバル最左 + range 最左）で除外されたセル数（帯全体）。 */
  posLabelCut: number
  /** インク無し（or range 最左ラベルで全消し）で塗らなかった非ラベルセル数（帯全体）。 */
  inkFiltered: number
}

/** mergeInkCellsInBand の戻り（range ごとの束ね枠 + 帯単位サマリ）。 */
interface BandMergeResult {
  merges: BandMerge[]
  summary: BandSummary
}

/**
 * v0.8 §4 / v0.8.1 §3-P1①②。レンジ束ね（判定軸 ink）＋横並び項目分割＋range 最左ラベル除外。
 *
 * v0.7.5 のレンジ束ねは「OCR written のレンジ」で束ねていたが、真因＝OCR が固有名詞・手書きを
 * 検出できない（§1）ため、v0.8 は記入有無を **セル内インク（前景ピクセル）有無**で判定する。
 *
 * v0.8.1 の差分（横並び 2 項目「部署｜氏名」を 1 枠化していた真因①②の解消）:
 *   - §3-P1① 横並び分割: インクありセルを x 昇順走査し、隣接インクセル間の空白が
 *     BAND_RANGE_SPLIT_GAP_PT を超えたら「横並び項目の境界」とみなし別 range に切る。
 *   - §3-P1② range 最左ラベル除外: 分割後の各 range の最左狭セルをラベル候補として除外する
 *     （帯内グローバル最左でない「氏名」ラベルもここで落ちる）。🚨 位置と幅のみ・地色不問（§0-A）。
 *   - 各 range を 1 枠にレンジ束ね（左端クランプ = ラベル列右端より内側、を range ごとに適用）。
 *
 * 処理順（設計 §3-P1②）:
 *   (1) 帯内グローバルのラベル除外（cluster / 帯内グローバル最左 posLabel）= インク判定の前段（v0.8 §5 維持）
 *   (2) 残りをインク判定し、インクありセルを収集
 *   (3) §3-P1① インクありセルを大ギャップで range 分割
 *   (4) §3-P1② 各 range の最左狭セルを追加でラベル除外（range ローカル posLabel）
 *   (5) 各 range の残りインクセルを 1 枠に束ね（左端クランプ range ごと）
 *
 * 空欄保護（§4）: インクありセルが 1 件も無ければ束ねゼロ（議題/添付/次回 空欄帯を巻き込まない）。
 *
 * 残A 左端クランプ（v0.7.5 §3-A）: レンジ左端を Math.max(inkLeftEdge, labelRightEdge) とし、
 *   除外したラベル列の右端より内側に確定（記入枠がラベルへ食い込まない）。背景色は一切参照しない。
 */
function mergeInkCellsInBand(
  bandCells: FieldBox[],
  pixels: RasterPagePixels | undefined,
  labelCenters: LabelCenter[],
  pageWidthPt: number,
): BandMergeResult {
  const sorted = [...bandCells].sort((a, b) => a.bbox.x - b.bbox.x)
  const bandTop = sorted.length > 0 ? Math.min(...sorted.map(c => c.bbox.y)) : 0
  // 残①: 帯内最左 x。帯内グローバル位置ラベル除外（OCR 非依存）の基準。
  const bandLeftMostX = sorted.length > 0 ? sorted[0].bbox.x : 0

  let labelCut = 0
  let posLabelCut = 0
  let inkFiltered = 0 // インク無しで塗られなかった非ラベルセル数（帯全体）。
  // 残A: 帯内グローバルで除外したラベル列の右端（range 左端クランプの初期基準）。
  let bandLabelRightEdge = bandLeftMostX
  // v0.8.2 §3-A: インクありセルを colHist とペアで保持する（range 最左ラベル除外で colHist の
  // 分散度を使うため。インク判定は (2) で 1 回だけ・再走査しない＝コスト最小）。
  const inkCells: InkCell[] = []

  // (1)(2): グローバルラベルを前段で除外し、残りをインク判定してインクありセルを集める。
  for (const cell of sorted) {
    // 残①: cluster 経由ラベル除外 OR 帯内グローバル最左位置ラベル除外。インク判定の前段で除く（§5）。
    const clusterLabel = isFieldItselfLabel(cell, labelCenters, pageWidthPt)
    const posLabel = isPositionalLabel(cell, bandLeftMostX, pageWidthPt)
    const isLabel = clusterLabel || posLabel
    if (isLabel) {
      if (posLabel && !clusterLabel) {
        posLabelCut++
        // [whiteout-diag][pos-label] 残①: 帯内グローバル最左狭セルの位置除外（地色不使用）。
        if (WHITEOUT_DIAG) {
          console.log(
            `[whiteout-diag][pos-label] p${cell.page} band(y=${cell.bbox.y.toFixed(1)}) ` +
              `bandLeftMost field(x=${cell.bbox.x.toFixed(1)} w=${cell.bbox.w.toFixed(1)}) ` +
              `leftMost=true narrow=true (bgIndependent) → excluded`,
          )
        }
      } else {
        labelCut++
      }
      // ラベル右端を更新（残A: 記入欄左端をこの内側にクランプ）。
      bandLabelRightEdge = Math.max(bandLabelRightEdge, cell.bbox.x + cell.bbox.w)
      continue
    }
    // v0.8 §2-2: 記入有無をインク（前景ピクセル）有無で判定。背景色非依存（bgLuma は相対基準のみ）。
    // v0.8.2 §3-B-1: ink.hasInk は端列縦ラン控除後の実効密度 AND maxComponent（散在ノイズ排除）。
    const ink = fieldHasInk(cell.bbox, pixels)
    if (WHITEOUT_DIAG) logInkCell(cell, ink, isLabel)
    // v0.8.1 §3-P1③: ink-dist 診断（観測専用・判定不変）。記入候補セルの前景画素の空間分布を出す。
    if (WHITEOUT_DIAG) logInkDist(cell, ink, pixels)
    // v0.8.2 §3-B-2: ink-name 診断（観測専用・判定不変）。氏名記入が拾えない原因（検出 bbox ズレ /
    // 実質空欄 / 薄字）を bbox 周辺±20pt 走査・最左8px除外実効比・delta別濃画素数・生luma16階調で切り分け。
    // 実機ログで氏名欄相当セル（x=403相当）を目視で拾う（観測専用なので全候補セルに出す）。
    if (WHITEOUT_DIAG) logInkName(cell, ink, pixels)
    if (ink.hasInk) {
      // v0.8.2 §3-A: range 最左ラベル除外で使う colHist をセルとペアで保持。
      inkCells.push({ cell, colHist: ink.colHist })
    } else {
      // インク無し細セルは塗らない（レンジ端の判定にのみ使い途中で切らない＝文字間空白で分断しない）。
      inkFiltered++
    }
  }

  const emptySummary: BandSummary = { labelCut, posLabelCut, inkFiltered }
  // §4 空欄保護: インクが 1 つも無ければ束ねゼロ（議題/添付/次回 空欄帯を巻き込まない）。
  if (inkCells.length === 0) return { merges: [], summary: emptySummary }

  // (3) §3-P1① 横並び分割: インクありセルを x 昇順走査し、隣接インクセル間の空白が
  //     BAND_RANGE_SPLIT_GAP_PT を超えたら横並び項目境界とみなして別 range に切る。
  //     inkCells は sorted 由来なので既に x 昇順。v0.8.2: InkCell ペア（cell + colHist）で扱う。
  const ranges: InkCell[][] = []
  let cur: InkCell[] = []
  for (const ic of inkCells) {
    if (cur.length > 0) {
      const prev = cur[cur.length - 1].cell
      const gap = ic.cell.bbox.x - (prev.bbox.x + prev.bbox.w)
      if (gap > BAND_RANGE_SPLIT_GAP_PT) {
        ranges.push(cur)
        cur = []
      }
    }
    cur.push(ic)
  }
  if (cur.length > 0) ranges.push(cur)

  // (4)(5): 各 range で最左ラベル除外 → 残りインクセルをレンジ束ね（左端クランプ range ごと）。
  const merges: BandMerge[] = []
  for (let ri = 0; ri < ranges.length; ri++) {
    const range = ranges[ri]
    const rangeLeftMostX = range[0].cell.bbox.x // range は x 昇順なので先頭が最左
    // §3-P1② / v0.8.2 §3-A range ローカル最左ラベル除外。🚨 位置(range 最左)+幅(狭い)+colHist 分散度のみ・
    // 地色不問（§0-A）。難所A: 場所記入左(分散)は残し氏名ラベル(端偏在)は除外（colHist のゼロ列数で区別）。
    let rangeLabelRightEdge = bandLabelRightEdge
    const rangeInk: FieldBox[] = []
    for (const ic of range) {
      const c = ic.cell
      if (isPositionalLabelInRange(c, rangeLeftMostX, pageWidthPt, ic.colHist)) {
        posLabelCut++
        rangeLabelRightEdge = Math.max(rangeLabelRightEdge, c.bbox.x + c.bbox.w)
        // [whiteout-diag][pos-label] range 最左ラベル除外の実値（colHist 偏在度 / 地色不使用を明示）。
        if (WHITEOUT_DIAG) {
          const zeroCols = ic.colHist.filter(v => v === 0).length
          console.log(
            `[whiteout-diag][pos-label] p${c.page} band(y=${c.bbox.y.toFixed(1)}) ` +
              `range#${ri} field(x=${c.bbox.x.toFixed(1)} w=${c.bbox.w.toFixed(1)}) ` +
              `rangeLeftMost=true narrow=true colHist=[${ic.colHist.join(',')}] ` +
              `colHistZero=${zeroCols} concentrated=true (bgIndependent) → excluded`,
          )
        }
        continue
      }
      rangeInk.push(c)
    }
    // range 最左がラベルで全部抜けた = この range は枠を作らない（除外済みなので inkFiltered は増やさない）。
    if (rangeInk.length === 0) continue

    const inkLeftEdge = Math.min(...rangeInk.map(c => c.bbox.x))
    const inkRightEdge = Math.max(...rangeInk.map(c => c.bbox.x + c.bbox.w))
    // §4 レンジ束ね（range 単位）＋残A 左端クランプ: ラベル列右端より内側を保証。
    const x = Math.max(inkLeftEdge, rangeLabelRightEdge)
    const x2 = inkRightEdge
    const y = Math.min(...rangeInk.map(c => c.bbox.y))
    const y2 = Math.max(...rangeInk.map(c => c.bbox.y + c.bbox.h))
    merges.push({
      bbox: { x, y, w: Math.max(0, x2 - x), h: y2 - y },
      bandTop,
      cellsIn: bandCells.length,
      labelCut,
      posLabelCut,
      emptyCut: inkFiltered,
      inkCells: rangeInk.length,
      writtenLeft: inkLeftEdge,
      writtenRight: inkRightEdge,
      labelRight: rangeLabelRightEdge,
      rangeCount: ranges.length,
      rangeIndex: ri,
    })
  }

  return { merges, summary: { labelCut, posLabelCut, inkFiltered } }
}

/**
 * v0.7.3 §3-2。エリアA セルを「同一帯（y(top) が BAND_GROUP_GAP_PT 以内）」にグルーピングする。
 * 検出側が同一 hLines ペアで y を共有するため、y の近接で帯を束ねる。
 */
function groupAreaACellsIntoBands(cells: FieldBox[]): FieldBox[][] {
  const sorted = [...cells].sort((a, b) => a.bbox.y - b.bbox.y)
  const bands: FieldBox[][] = []
  let cur: FieldBox[] = []
  let bandTop = Number.NEGATIVE_INFINITY
  for (const c of sorted) {
    if (cur.length === 0 || Math.abs(c.bbox.y - bandTop) <= BAND_GROUP_GAP_PT) {
      if (cur.length === 0) bandTop = c.bbox.y
      cur.push(c)
    } else {
      bands.push(cur)
      cur = [c]
      bandTop = c.bbox.y
    }
  }
  if (cur.length > 0) bands.push(cur)
  return bands
}

/** suggestWhiteoutCandidatesByField の診断カウンタ（route の diag log 用）。 */
export interface FieldSuggestDiag {
  areaA: number
  areaB: number
  labelExcluded: number
  /** v0.7.4 §8: 位置ベース直接ラベル除外（OCR 非依存）で落ちた数。cluster 除外と分ける。 */
  posLabelExcluded: number
  /** v0.8 §8: インク無し（前景ピクセル不足）で塗らなかったセル/大枠の数（旧 writtenFiltered）。 */
  inkFiltered: number
  /** v0.7.3 §8 / v0.8: 束ね（mergeInkCellsInBand）で生成された枠数。 */
  merged: number
  painted: number
}

/**
 * 真因診断ログ。field/written/label の座標を実値で dump して、座標系一致性 / どの field が
 * どの理由で除外されたかを見える化する。既定 ON、`WHITEOUT_DIAG=0` で抑制可能。
 */
const WHITEOUT_DIAG = process.env.WHITEOUT_DIAG !== '0'

/**
 * 罫線検出で得た field_bbox（エリアA セル + エリアB 大枠）を白塗り対象 WhiteoutBox[] に変換する。
 * 方針:
 *   ① 背景色を一切参照しない。判定は罫線 + written_bbox + role のみ。
 *   ② inset で外周・セル境界の罫線を残す（塗り過小側）。
 *   ③ 記入有無フィルタ: written_bbox がある欄だけ塗り、空欄は塗らない。
 *
 * 判定順（§3-3）:
 *   (1) 3 重ラベル判定（§5-2）→ ラベルなら記入有無に関わらず塗らない（ラベルは残す）
 *   (2) 記入有無フィルタ（§3-2）→ written_bbox が無ければ塗らない（空欄は元から空白）
 *   (3) inset 塗り（§5-1）→ 記入ありなら罫線内側まで枠いっぱい塗る
 *
 * role / cluster は補助（§5-3）。role 失敗（classifications=[]）でも位置 + 語彙でラベル除外、
 * エリアB は外周罫線 + インクで成立するため role 非依存（§5-3）。
 *
 * v0.8 §4 差分: 記入有無を OCR written → セル内インク（前景ピクセル）有無に差し替え（真因＝OCR漏れ）。
 *   塗り判定に ocr は使わない（pixels のインク判定が主役）。ocr はラベル判定用の pageWidthPt 源
 *   としてのみ残置（OCR 呼び出し自体は §6 で温存）。pixels が無い場合は後方互換で塗らない。
 *
 * v0.8.2 差分（設計書 n6_layout_structure_draft_v0.8.2・全て背景色非依存 §0-A）:
 *   ① 横並び分割閾値 BAND_RANGE_SPLIT_GAP_PT 40→28（部署|氏名32 は割り氏名内22 は割らない・const 変更）。
 *   ② 難所A（§3-A）: isPositionalLabelInRange に colHist 分散度を併用（場所記入左[分散]は残し氏名ラベル
 *      [端偏在]は除外）。③-B-1（§3-B-1）: hasInkInCell が端列縦フルランを罫線として控除→実効 ink で density
 *      判定 ＋ maxComponent >= INK_MIN_COMPONENT を AND（部署空欄の左右縦罫線が落ち・散在ノイズも落ちる）。
 *   ③-B-2 ink-name 追加診断（観測専用・判定不変）: 氏名記入が拾えない原因（検出 bbox ズレ / 実質空欄 /
 *      薄字）の切り分けデータを出す。氏名対策は次サイクル（実機 ink-name 実値で方針確定）。
 *   🚨 ②③とも前景幾何（colHist / 端列縦ラン / maxComponent）のみ・地色不使用。bgLuma は診断表示のみ判定不使用。
 *
 * applyWhiteout / suggestWhiteoutCandidatesByRole は無改変（並置、§12）。
 *
 * @param fieldBoxes      detectFieldBboxes の出力（エリアA/B、pt・左上原点）
 * @param cluster         buildLayoutCluster の出力（cell bbox 源、3 重ラベル判定用）
 * @param classifications classifyCellRoles の出力（cellId → role、補助）
 * @param ocr             ScanOcrResult（v0.8: pageWidthPt 源としてのみ。塗り判定には不使用）
 * @param diag            （任意）診断カウンタを書き戻す out 参照
 * @param pixelsByPage    v0.8: ページ別の共有ラスタ画素（インク判定用・再デコード回避）
 * @returns               ラベル除外 + インク有無フィルタ通過後の inset 済 WhiteoutBox[]
 */
export function suggestWhiteoutCandidatesByField(
  fieldBoxes: FieldBox[],
  cluster: LayoutCluster,
  classifications: CellClassification[],
  ocr?: ScanOcrResult,
  diag?: FieldSuggestDiag,
  pixelsByPage?: RasterPagePixels[],
): WhiteoutBox[] {
  const roleByCellId = new Map(classifications.map(c => [c.cellId, c.role]))

  // v0.8: ページ別の共有ラスタ画素（インク判定用）。page 番号で引けるよう Map 化。
  const pixelsByPageNo = new Map<number, RasterPagePixels>()
  if (pixelsByPage) {
    for (const px of pixelsByPage) pixelsByPageNo.set(px.page, px)
  }

  // ページごとの「ラベルセル中心」を 3 重判定で収集（背景色不使用）。
  // ページ幅 pt は ocr.pages[].pageSize から取得。OCR 無指定でも pixels の pageWidthPt で補完
  // （v0.8: 塗り判定は OCR 非依存だが、位置ラベル判定にページ幅が要るため pixels からも引く）。
  const pageWidthPtByPage = new Map<number, number>()
  if (ocr) {
    for (const p of ocr.pages) {
      pageWidthPtByPage.set(p.pageIndex + 1, p.pageSize.widthPt)
    }
  }
  for (const px of pixelsByPageNo.values()) {
    if (!pageWidthPtByPage.has(px.page)) pageWidthPtByPage.set(px.page, px.pageWidthPt)
  }
  // v0.7.3 §3-1: ラベルセル中心 + cellBbox を保持（面積比「ほぼ一致」判定に bbox が必要）。
  const labelCentersByPage = new Map<number, LabelCenter[]>()
  for (const page of cluster.pages) {
    for (const cell of page.cells) {
      const role = roleByCellId.get(cell.cellId)
      const pageWidthPt = pageWidthPtByPage.get(cell.page) ?? Number.POSITIVE_INFINITY
      if (isLabelCell(cell, role, pageWidthPt)) {
        const arr = labelCentersByPage.get(cell.page) ?? []
        arr.push({
          cx: cell.bbox.x + cell.bbox.w / 2,
          cy: cell.bbox.y + cell.bbox.h / 2,
          cellBbox: { ...cell.bbox },
        })
        labelCentersByPage.set(cell.page, arr)
        // [whiteout-diag] 依頼2: このラベルセルが「位置」で当たったか「語彙」で当たったか「role」かを内訳表示。
        if (WHITEOUT_DIAG) {
          const byRole = role === 'label'
          const byLex = cell.labelLexiconHit
          const byPos =
            cell.isLeftmostInRow && cell.bbox.w <= pageWidthPt * LEFT_LABEL_COL_MAX_W_RATIO
          console.log(
            `[whiteout-diag][label] p${cell.page} ${cell.cellId} ${fmtBox(cell.bbox)} ` +
              `hit=${byRole ? 'ROLE' : ''}${byLex ? 'LEX' : ''}${byPos ? 'POS' : ''} ` +
              `leftmost=${cell.isLeftmostInRow} wRatio=${(cell.bbox.w / pageWidthPt).toFixed(3)}(thr=${LEFT_LABEL_COL_MAX_W_RATIO}) ` +
              `text="${cell.text.slice(0, 12)}"`,
          )
        }
      }
    }
  }
  if (WHITEOUT_DIAG) {
    const totalCells = cluster.pages.reduce((n, p) => n + p.cells.length, 0)
    const totalLabels = [...labelCentersByPage.values()].reduce((n, a) => n + a.length, 0)
    console.log(
      `[whiteout-diag][label] summary clusterCells=${totalCells} labelCells=${totalLabels} pageWidthPt=${[...pageWidthPtByPage.values()].map(v => v.toFixed(0)).join(',')}`,
    )
  }

  let areaA = 0
  let areaB = 0
  let labelExcluded = 0
  let posLabelExcluded = 0
  let inkFiltered = 0

  // [whiteout-diag-timing] v0.8: インク判定（候補セル × セル面積走査 = O(セル面積総和)）の所要 ms。
  const tSuggest = Date.now()

  // v0.8 §4: ページごとに field を分け、エリアA は帯グルーピング + インクレンジ束ね、エリアB は
  // field 単位でインク判定。検出側 area で A/B を振り分ける（背景色非依存・インクは局所相対）。
  const pages = new Set<number>(fieldBoxes.map(fb => fb.page))
  const boxes: WhiteoutBox[] = []
  let merged = 0

  // v0.8.1 §3-P2/P3: 罫線被り補正（inset とは別レイヤ）。検出 field bbox の辺が罫線際にあるとき、
  // 塗り矩形の該当辺を罫線内側へ LINE_OVERLAP_FIX_PX だけクランプする。inset の一律内側量（P5 で 3px）を
  // 増やさずに被り辺だけ追加で内側へ寄せ、罫線保持を両立する（§3-P5 切り分け）。
  // 🚨 背景色非依存（§0-A）: クランプは field/罫線座標の幾何のみで、地色は一切見ない。
  const applyLineFix = (
    raw: PdfBox,
    fix: { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean },
  ): PdfBox => {
    let { x, y, w, h } = raw
    if (fix.left) { x += LINE_OVERLAP_FIX_PX; w -= LINE_OVERLAP_FIX_PX } // 左罫線被り → 左端を内側へ
    if (fix.right) { w -= LINE_OVERLAP_FIX_PX } // 右罫線被り → 右端を内側へ
    if (fix.top) { y += LINE_OVERLAP_FIX_PX; h -= LINE_OVERLAP_FIX_PX } // 上罫線被り → 上端を内側へ
    if (fix.bottom) { h -= LINE_OVERLAP_FIX_PX } // 下罫線被り → 下端を内側へ
    return { x, y, w: Math.max(0, w), h: Math.max(0, h) }
  }

  // inset 後に幅/高が 0 へ潰れた矩形は描画上無意味なので push しない（全辺 inset が
  // 極細セル幅/高を超えるケースの安全弁。塗り過小側に倒す方針と整合・v0.7.3 継承）。
  // lineFix: §3-P2/P3 罫線被り補正辺（指定辺を inset 前に罫線内側へクランプ）。
  const pushInsetBox = (
    page: number,
    raw: PdfBox,
    lineFix?: { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean },
  ): void => {
    // §3-P2/P3: inset の前段で被り辺を罫線内側へクランプ（inset とは別レイヤ）。
    const fixed = lineFix ? applyLineFix(raw, lineFix) : raw
    const lineFixed = lineFix
      ? !!(lineFix.left || lineFix.right || lineFix.top || lineFix.bottom)
      : false
    const { bbox, clamped } = insetBox(fixed)
    // [whiteout-diag][inset] 残③/§3-P2/P3: 罫線被り補正後 + 全辺 inset 後の座標と潰れ(clamped)有無。
    if (WHITEOUT_DIAG) {
      console.log(
        `[whiteout-diag][inset] p${page} field(${fmtBox(raw)}) ` +
          `lineFix=${lineFixed ? fmtBox(fixed) : 'none'} → inset{${fmtBox(bbox)}} clamped=${clamped}`,
      )
    }
    if (clamped) return
    boxes.push({
      page,
      bbox,
      estimatedBgColor: DEFAULT_BG_COLOR_WHITE,
      source: 'auto_suggestion',
    })
  }

  for (const pageNo of pages) {
    const pageFields = fieldBoxes.filter(fb => fb.page === pageNo)
    const labelCenters = labelCentersByPage.get(pageNo) ?? []
    const pageWidthPt = pageWidthPtByPage.get(pageNo) ?? Number.POSITIVE_INFINITY
    const pixels = pixelsByPageNo.get(pageNo)

    const areaAFields = pageFields.filter(fb => fb.area === 'A')
    const areaBFields = pageFields.filter(fb => fb.area === 'B')
    areaA += areaAFields.length
    areaB += areaBFields.length

    // --- エリアB 大枠: 束ね対象外。field 単位で label 解除（§5）+ インク判定（§2-2）。 ---
    for (const fb of areaBFields) {
      const decision = decideFieldItselfLabel(fb, labelCenters, pageWidthPt)
      if (decision.isLabel) {
        labelExcluded++
        if (WHITEOUT_DIAG) logExcludeLabel(fb, decision)
        continue
      }
      // v0.8: pixels があればインク有無で記入判定（OCR非依存）。pixels 無指定（後方互換）は塗らない。
      if (pixels) {
        const ink = fieldHasInk(fb.bbox, pixels)
        if (WHITEOUT_DIAG) logInkCell(fb, ink, false)
        if (!ink.hasInk) {
          inkFiltered++
          continue
        }
      } else {
        // 後方互換（画素なし）: 記入有無を判定できないので塗らない（空欄保護側に倒す）。
        inkFiltered++
        continue
      }
      // v0.8.1 §3-P3: 議事内容大枠の下端が罫線際 → 下辺を罫線内側へクランプ（大枠下罫線被り）。
      pushInsetBox(fb.page, fb.bbox, { bottom: true })
    }

    // --- エリアA 細セル: 帯グルーピング → 帯内でラベル(cluster/位置)除外 + インクレンジ束ね。 ---
    const bands = groupAreaACellsIntoBands(areaAFields)
    for (const band of bands) {
      // 残①: 帯内最左 x（pixels 無指定時の後方互換ラベル除外の基準）。
      const bandLeftMostX =
        band.length > 0 ? Math.min(...band.map(c => c.bbox.x)) : 0

      // pixels 未指定（後方互換）: インク判定不能。ラベル(cluster/位置)以外を個別 inset 塗り（v0.7 互換挙動）。
      // この経路では横並び分割（インク基準）は走らないため、帯内グローバル最左ラベルのみ除外する。
      if (!pixels) {
        for (const cell of band) {
          if (isFieldItselfLabel(cell, labelCenters, pageWidthPt)) {
            labelExcluded++
            continue
          }
          if (isPositionalLabel(cell, bandLeftMostX, pageWidthPt)) {
            posLabelExcluded++
            continue
          }
          pushInsetBox(cell.page, cell.bbox)
        }
        continue
      }

      // v0.8 §4 / v0.8.1 §3-P1①②: インクありセルの横並び分割 + range 最左ラベル除外 + レンジ束ね。
      // ラベル除外/インク無しのカウントは mergeInkCellsInBand 内で帯単位に集計し summary で受ける
      // （range 重複の二重計上を避けるため呼び出し側での事前カウントは廃止）。
      const { merges: mergedBoxes, summary } = mergeInkCellsInBand(
        band,
        pixels,
        labelCenters,
        pageWidthPt,
      )
      labelExcluded += summary.labelCut
      posLabelExcluded += summary.posLabelCut
      inkFiltered += summary.inkFiltered
      for (const m of mergedBoxes) {
        merged++
        if (WHITEOUT_DIAG) {
          // v0.8 §8 / v0.8.1: [ink-band] インクありセル数とレンジ束ね結果（ranges/split 追加）。
          console.log(
            `[whiteout-diag][ink-band] p${pageNo} band(y=${m.bandTop.toFixed(1)}) ` +
              `cellsIn=${m.cellsIn} labelCut=${m.labelCut} posLabelCut=${m.posLabelCut} ` +
              `emptyCut=${m.emptyCut} inkCells=${m.inkCells} writtenLeft=${m.writtenLeft.toFixed(1)} ` +
              `writtenRight=${m.writtenRight.toFixed(1)} labelRight=${m.labelRight.toFixed(1)} ` +
              `ranges=${m.rangeCount} split=${m.rangeIndex} ` +
              `rangeW=${m.bbox.w.toFixed(1)} mergedTo={${fmtBox(m.bbox)}}`,
          )
        }
        // v0.8.1 §3-P2: エリアA 記入欄の左端が罫線際 → 左辺を罫線内側へクランプ（記入欄左罫線被り）。
        pushInsetBox(pageNo, m.bbox, { left: true })
      }
    }
  }

  console.log(
    `[whiteout-diag-timing] suggestByField(ink O(cellArea))=${Date.now() - tSuggest}ms ` +
      `fields=${fieldBoxes.length} merged=${merged} painted=${boxes.length}`,
  )

  if (diag) {
    diag.areaA = areaA
    diag.areaB = areaB
    diag.labelExcluded = labelExcluded
    diag.posLabelExcluded = posLabelExcluded
    diag.inkFiltered = inkFiltered
    diag.merged = merged
    diag.painted = boxes.length
  }

  return boxes
}

