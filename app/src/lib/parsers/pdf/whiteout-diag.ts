import type { PdfBox } from './pdf-types'
import {
  type FieldBox,
  type RasterPagePixels,
  INK_BORDER_MARGIN_PX,
  INK_LUMA_DELTA,
  INK_SCAN_STEP,
  MIN_INK_SCAN_PX,
  INK_MIN_COMPONENT,
} from './field-bbox-detector'
import type { InkResult, FieldLabelDecision } from './whiteout-pipeline'

/**
 * v0.8.2 §3-B-2 ink-name 診断専用パラメータ（**観測のみ・判定不使用**）。検出側 const ではなく
 * pipeline ローカル（判定に効かない診断パラメータなので field-bbox-detector の判定用 const とは分離）。
 *   - INK_NAME_LEFT_SKIP_PX: 最左の縦罫線を物理的に外して実効 inkRatio を見るため捨てる px（§3-B-2 (B)）。
 *   - INK_NAME_SCAN_EXPAND_PT: bbox を左右に広げて記入文字が bbox 外に在るか見る走査拡張量 pt（§3-B-2 (D)）。
 * 氏名原因確定後に ink-name ごと削除予定（§8）。
 */
const INK_NAME_LEFT_SKIP_PX = 8
const INK_NAME_SCAN_EXPAND_PT = 20

export function fmtBox(b: PdfBox): string {
  return `x=${b.x.toFixed(1)} y=${b.y.toFixed(1)} w=${b.w.toFixed(1)} h=${b.h.toFixed(1)}`
}

/** §8 課題① の判定内訳ログ（面積比で残ったか / 全幅帯で除外維持か / エリアB ガードで残ったか）。 */
export function logExcludeLabel(fb: FieldBox, decision: FieldLabelDecision): void {
  console.log(
    `[whiteout-diag][exclude:label] p${fb.page} area=${fb.area} field(${fmtBox(fb.bbox)}) ` +
      `labelArea=${decision.labelArea?.toFixed(1) ?? 'n/a'} fieldArea=${decision.fieldArea?.toFixed(1) ?? 'n/a'} ` +
      `ratio=${decision.ratio?.toFixed(2) ?? 'n/a'} reason=${decision.reason}`,
  )
}

/**
 * v0.8 §8 核心。各セル/大枠のインク判定内訳ログ。
 * 場所/出席者セルが inkRatio で拾えたか・空欄が inkRatio≈0 か実機で切り分ける。
 * 🚨 bgLuma は観測用に出すが、塗り判定には絶対値を使わない（§0-A。判定は inkRatio のみ）。
 */
export function logInkCell(fb: FieldBox, ink: InkResult, isLabel: boolean): void {
  // v0.8.2 §8: 端列縦罫線除去後の実効 ink / 最大成分を出す（部署空欄が落ち氏名/記入が残るか確認）。
  // 🚨 bgLuma は観測用に出すが、塗り判定には絶対値を使わない（§0-A。判定は effectiveInkRatio AND maxComponent）。
  console.log(
    `[whiteout-diag][ink] p${fb.page} area=${fb.area} cell(${fmtBox(fb.bbox)}) ` +
      `bgLuma=${ink.bgLuma} rawInkPixels=${ink.rawInkPixels} edgeVRunRemoved=${ink.edgeVRun} ` +
      `effectiveInkRatio=${ink.inkRatio.toFixed(4)} maxComponent=${ink.maxComponent}(min=${INK_MIN_COMPONENT}) ` +
      `hasInk=${ink.hasInk} isLabel=${isLabel} → ${ink.hasInk ? 'painted' : 'skip'}`,
  )
}

/**
 * v0.8.1 §3-P1③ / §8。ink-dist 診断（**観測専用・判定ロジックには一切影響しない**）。
 *
 * 難所（真因③）: 部署空欄 inkRatio=0.0373 > 氏名記入 0.0326 の密度逆転。密度だけでは分離不可。
 * このログで「部署空欄が拾っている前景画素が、散在ノイズ（小成分多数）か / 罫線残り（端の列に
 * 集中）か / margin 外縦罫線（特定列に縦ラン）か / 記入（中央の大きな塊）か」を実値で切り分ける。
 * → 次サイクルで INK_MIN_COMPONENT（まとまり下限）と手法（連結成分 or 最長ラン）を確定するための
 *   観測データを取るのが目的。**v0.8.1 では判定（hasInk=inkRatio>=INK_MIN_DENSITY）は不変・painted 不変**。
 *
 * 出力する幾何量（すべて前景インク画素の空間分布。🚨 地色 bgLuma は絶対値判定に使わない・§0-A）:
 *   - inkPixels: 走査サンプル空間でのインク画素数
 *   - components / maxComponent: 連結成分（4近傍）の数と最大成分サイズ
 *   - maxRunRow / maxRunCol: 行投影・列投影それぞれの最長連続インクラン
 *   - colHist / rowHist: x 方向・y 方向の 8 分割インク画素ヒストグラム（端集中=罫線 / 散在 / 中央塊）
 *
 * コスト: 候補セルのみ・INK_SCAN_STEP 間引きの走査サンプル空間で計算（既存 pixels 共有・再デコード0・
 * 新規依存0）。連結成分は反復スタック BFS（再帰なし）で軽量。
 */
export function logInkDist(
  fb: FieldBox,
  ink: InkResult,
  pixels: RasterPagePixels | undefined,
): void {
  if (!pixels) return
  const data = pixels.data
  const W = pixels.pixelWidth
  const H = pixels.pixelHeight
  const pxPerPtX = W / pixels.pageWidthPt
  const pxPerPtY = H / pixels.pageHeightPt

  // fieldHasInk と同じ走査領域（罫線厚 margin 内側 + 画像範囲クランプ）。
  const x0 = Math.max(0, Math.round(fb.bbox.x * pxPerPtX) + INK_BORDER_MARGIN_PX)
  const y0 = Math.max(0, Math.round(fb.bbox.y * pxPerPtY) + INK_BORDER_MARGIN_PX)
  const x1 = Math.min(W, Math.round((fb.bbox.x + fb.bbox.w) * pxPerPtX) - INK_BORDER_MARGIN_PX)
  const y1 = Math.min(H, Math.round((fb.bbox.y + fb.bbox.h) * pxPerPtY) - INK_BORDER_MARGIN_PX)
  if (x1 - x0 < MIN_INK_SCAN_PX || y1 - y0 < MIN_INK_SCAN_PX) return

  // 走査サンプル空間（INK_SCAN_STEP 間引き）でインクビットマップを作る。
  // インク = 「セル地色（ink.bgLuma）より INK_LUMA_DELTA 以上濃い」前景画素（fieldHasInk と同基準）。
  // bgLuma は相対基準としてのみ使用（絶対値で白/グレー分類しない＝§0-A）。
  const step = INK_SCAN_STEP > 0 ? INK_SCAN_STEP : 1
  const cols = Math.max(1, Math.ceil((x1 - x0) / step))
  const rows = Math.max(1, Math.ceil((y1 - y0) / step))
  const inkMap = new Uint8Array(cols * rows)
  const inkLumaMax = ink.bgLuma - INK_LUMA_DELTA
  let inkPixels = 0
  let ci = 0
  for (let y = y0; y < y1; y += step, ci++) {
    let cj = 0
    for (let x = x0; x < x1; x += step, cj++) {
      const i = (y * W + x) * 4
      const luma = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8
      if (luma <= inkLumaMax) {
        inkMap[ci * cols + cj] = 1
        inkPixels++
      }
    }
  }

  // 行投影・列投影の最長連続インクラン（記入文字は数 px 連続を持ち、散在ノイズは持たない）。
  let maxRunRow = 0
  for (let r = 0; r < rows; r++) {
    let run = 0
    for (let c = 0; c < cols; c++) {
      if (inkMap[r * cols + c]) {
        run++
        if (run > maxRunRow) maxRunRow = run
      } else {
        run = 0
      }
    }
  }
  let maxRunCol = 0
  for (let c = 0; c < cols; c++) {
    let run = 0
    for (let r = 0; r < rows; r++) {
      if (inkMap[r * cols + c]) {
        run++
        if (run > maxRunCol) maxRunCol = run
      } else {
        run = 0
      }
    }
  }

  // 連結成分（4 近傍・反復スタック BFS）。成分数と最大成分サイズ。
  const visited = new Uint8Array(cols * rows)
  const stack: number[] = []
  let components = 0
  let maxComponent = 0
  for (let s = 0; s < cols * rows; s++) {
    if (!inkMap[s] || visited[s]) continue
    components++
    let size = 0
    stack.length = 0
    stack.push(s)
    visited[s] = 1
    while (stack.length > 0) {
      const idx = stack.pop() as number
      size++
      const r = (idx / cols) | 0
      const c = idx - r * cols
      // 上下左右
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

  // x 方向 / y 方向の 8 分割インク分布（端集中=罫線残り / 散在 / 中央塊 の切り分け）。
  const BINS = 8
  const colHist = new Int32Array(BINS)
  const rowHist = new Int32Array(BINS)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!inkMap[r * cols + c]) continue
      colHist[Math.min(BINS - 1, ((c * BINS) / cols) | 0)]++
      rowHist[Math.min(BINS - 1, ((r * BINS) / rows) | 0)]++
    }
  }

  console.log(
    `[whiteout-diag][ink-dist] p${fb.page} area=${fb.area} cell(${fmtBox(fb.bbox)}) ` +
      `bgLuma=${ink.bgLuma} inkRatio=${ink.inkRatio.toFixed(4)} ` +
      `inkPixels=${inkPixels} scan=${cols}x${rows} ` +
      `components=${components} maxComponent=${maxComponent} ` +
      `maxRunRow=${maxRunRow} maxRunCol=${maxRunCol} ` +
      `colHist=[${Array.from(colHist).join(',')}] rowHist=[${Array.from(rowHist).join(',')}]`,
  )
}

/**
 * v0.8.2 §3-B-2（難所B後半）。ink-name 追加診断（**観測専用・判定ロジックには一切影響しない**）。
 *
 * 難所B（氏名記入が拾えない真因確定）: 実機 ink-dist で氏名記入セル(x=403)の colHist 列1〜7 が全ゼロ＝
 * 検出セルの走査範囲に記入文字成分が無い（仮説2に確定）。本診断は「検出 bbox ズレか実質空欄か」を
 * 切り分けるため、氏名欄相当セルについて次を観測する（設計 §3-B-2・最新版 = bbox 周辺±20pt 走査）:
 *   (A) 生 luma 16 階調ヒストグラム（薄字が存在するか・地色がどこに分布するか）
 *   (B) margin 内側の最左 INK_NAME_LEFT_SKIP_PX(=8px) を除いた実効 inkRatio
 *       （左の縦罫線を物理的に外して、記入文字が残るか見る。§3-B-1 とは別に「最左数 px を捨てた」素の比）
 *   (C) INK_LUMA_DELTA 別（30/40/50/60）の濃画素数（薄字＝delta 下げで出るかの保険・仮説1）
 *   (D) bbox を左右に INK_NAME_SCAN_EXPAND_PT(=±20pt) 広げた走査領域の colHist
 *       （記入文字が検出 bbox の外＝左の罫線際 / 右の隣セル寄りに在るか＝bbox ズレ判定）
 *
 * 判定には使わない（hasInk / painted は不変）。実機実値で次サイクル方針（検出側 v0.8.3 / delta 下げ /
 * 実質空欄で塗らない）を確定するための観測データを取るのが目的。氏名対策は次サイクル。
 *
 * 🚨 背景色非依存（§0-A）: 生 luma / bgLuma は **観測表示のみ**で塗る塗らない判定に絶対値を使わない。
 * 実効 inkRatio・colHist は前景インク画素（bgLuma 相対）の幾何。コスト: 候補セルのみ・INK_SCAN_STEP 間引き
 * （既存 pixels 共有・再デコード0・新規依存0）。ink-name は氏名原因確定後に削除予定（§8）。
 */
export function logInkName(
  fb: FieldBox,
  ink: InkResult,
  pixels: RasterPagePixels | undefined,
): void {
  if (!pixels) return
  const data = pixels.data
  const W = pixels.pixelWidth
  const H = pixels.pixelHeight
  const pxPerPtX = W / pixels.pageWidthPt
  const pxPerPtY = H / pixels.pageHeightPt
  const step = INK_SCAN_STEP > 0 ? INK_SCAN_STEP : 1

  // fieldHasInk と同じ基本走査領域（罫線厚 margin 内側 + 画像範囲クランプ）。
  const bx0 = Math.round(fb.bbox.x * pxPerPtX) + INK_BORDER_MARGIN_PX
  const by0 = Math.round(fb.bbox.y * pxPerPtY) + INK_BORDER_MARGIN_PX
  const bx1 = Math.round((fb.bbox.x + fb.bbox.w) * pxPerPtX) - INK_BORDER_MARGIN_PX
  const by1 = Math.round((fb.bbox.y + fb.bbox.h) * pxPerPtY) - INK_BORDER_MARGIN_PX
  const x0 = Math.max(0, bx0)
  const y0 = Math.max(0, by0)
  const x1 = Math.min(W, bx1)
  const y1 = Math.min(H, by1)
  if (x1 - x0 < MIN_INK_SCAN_PX || y1 - y0 < MIN_INK_SCAN_PX) return

  const inkLumaMax = ink.bgLuma - INK_LUMA_DELTA

  // (A) 生 luma 16 階調ヒストグラム（0..15 = luma>>4）。薄字 / 地色の分布を観測。
  const lumaHist16 = new Int32Array(16)
  // (C) delta 別（30/40/50/60）濃画素数。薄字が delta 下げで出るかの保険（仮説1）。
  const deltas = [30, 40, 50, 60]
  const deltaCounts = [0, 0, 0, 0]
  let total = 0
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * W + x) * 4
      const luma = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8
      lumaHist16[Math.min(15, luma >> 4)]++
      total++
      for (let d = 0; d < deltas.length; d++) {
        if (luma <= ink.bgLuma - deltas[d]) deltaCounts[d]++
      }
    }
  }

  // (B) margin 内側の最左 INK_NAME_LEFT_SKIP_PX を物理的に外した実効 inkRatio（左縦罫線を除いて見る）。
  const xSkip = Math.min(x1, x0 + INK_NAME_LEFT_SKIP_PX)
  let inkSkip = 0
  let totalSkip = 0
  for (let y = y0; y < y1; y += step) {
    for (let x = xSkip; x < x1; x += step) {
      const i = (y * W + x) * 4
      const luma = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8
      if (luma <= inkLumaMax) inkSkip++
      totalSkip++
    }
  }
  const inkRatioLeftSkip = totalSkip > 0 ? inkSkip / totalSkip : 0

  // (D) bbox を左右に INK_NAME_SCAN_EXPAND_PT 広げた走査領域の 8 分割 colHist（記入文字が bbox 外に在るか）。
  const expandPx = Math.round(INK_NAME_SCAN_EXPAND_PT * pxPerPtX)
  const ex0 = Math.max(0, bx0 - expandPx)
  const ex1 = Math.min(W, bx1 + expandPx)
  const BINS = 8
  const expColHist = new Int32Array(BINS)
  const ecols = Math.max(1, ex1 - ex0)
  for (let y = y0; y < y1; y += step) {
    for (let x = ex0; x < ex1; x += step) {
      const i = (y * W + x) * 4
      const luma = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8
      if (luma > inkLumaMax) continue
      expColHist[Math.min(BINS - 1, (((x - ex0) * BINS) / ecols) | 0)]++
    }
  }

  console.log(
    `[whiteout-diag][ink-name] p${fb.page} area=${fb.area} cell(${fmtBox(fb.bbox)}) ` +
      `bgLuma=${ink.bgLuma} inkRatio=${ink.inkRatio.toFixed(4)} ` +
      `lumaHist16=[${Array.from(lumaHist16).join(',')}] (16-step raw luma, bgIndependent obs) ` +
      `inkRatioLeftSkip${INK_NAME_LEFT_SKIP_PX}px=${inkRatioLeftSkip.toFixed(4)} ` +
      `deltaCounts{30/40/50/60}=[${deltaCounts.join(',')}]/total${total} ` +
      `expandColHist(±${INK_NAME_SCAN_EXPAND_PT}pt)=[${Array.from(expColHist).join(',')}] ` +
      `(obs-only, judgement unchanged)`,
  )
}
