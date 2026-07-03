import type { PdfBox } from './pdf-types'
import { type RasterPagePixels } from './field-bbox-detector'
import {
  INK_LUMA_DELTA,
  INK_MIN_DENSITY,
  INK_BORDER_MARGIN_PX,
  INK_SCAN_STEP,
  MIN_INK_SCAN_PX,
  VLINE_RESIDUE_RUN_RATIO,
  INK_MIN_COMPONENT,
} from './whiteout-constants'

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
export function fieldHasInk(
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
