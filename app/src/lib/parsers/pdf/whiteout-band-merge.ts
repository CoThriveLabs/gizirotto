import type { PdfBox } from './pdf-types'
import type { FieldBox, RasterPagePixels } from './field-bbox-detector'
import type { LabelCenter } from './whiteout-label-classifier'
import { isFieldItselfLabel, isPositionalLabel, isPositionalLabelInRange } from './whiteout-label-classifier'
import { fieldHasInk } from './whiteout-ink-detector'
import { BAND_GROUP_GAP_PT, BAND_RANGE_SPLIT_GAP_PT } from './whiteout-constants'
import { logInkCell, logInkDist, logInkName, WHITEOUT_DIAG } from './whiteout-diag'

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
export interface BandMerge {
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
export interface BandSummary {
  /** cluster 経由ラベルで除外されたセル数（帯全体）。 */
  labelCut: number
  /** 位置ラベル（帯内グローバル最左 + range 最左）で除外されたセル数（帯全体）。 */
  posLabelCut: number
  /** インク無し（or range 最左ラベルで全消し）で塗らなかった非ラベルセル数（帯全体）。 */
  inkFiltered: number
}

/** mergeInkCellsInBand の戻り（range ごとの束ね枠 + 帯単位サマリ）。 */
export interface BandMergeResult {
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
export function mergeInkCellsInBand(
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
export function groupAreaACellsIntoBands(cells: FieldBox[]): FieldBox[][] {
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
