/**
 * bbox エディタ座標変換 純関数（G2-1 設計書 v0.2 §3 / §5）。px↔pt↔表示px の変換系。
 *
 * 座標の三層:
 *   1. pt（保存）   : PdfField.bbox の単位。左上原点 {x,y,w,h}。
 *   2. 元画像 px    : ラスタ PNG 解像度（pixelWidth/pixelHeight）。
 *   3. 表示 px      : 画面表示。displayWidth = min(pixelWidth, MAX_DISPLAY_WIDTH)。
 *
 * 設計方針（±4px 担保の核）:
 *   - 1px ステップ = 表示 px ではなく「元画像 1px 分の pt」。displayScale で表示が
 *     縮小されても pt 換算は元画像 px 基準で一定。
 *   - 編集中は丸めず float の pt を保持。保存時のみ pt を小数 2 桁へ丸める。
 *   - 途中で px↔pt を往復させない（往復のたびの丸め誤差蓄積を避ける）。
 */
import {
  MAX_DISPLAY_WIDTH,
  SAVE_PT_DECIMALS,
  ZOOM_MIN,
  ZOOM_MAX,
  type PageMeta,
  type BboxPt,
  type FitOptions,
} from './bbox-coords-constants'

/** ズーム倍率を [ZOOM_MIN, ZOOM_MAX] にクランプ。 */
export function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))
}

/** displayWidth 系の第2引数（number=従来 containerWidth / FitOptions）を正規化。 */
function normalizeFitOptions(opts?: number | FitOptions): FitOptions {
  return typeof opts === 'number' ? { containerWidth: opts } : (opts ?? {})
}

/**
 * 表示幅。第2引数省略時は従来どおり min(pixelWidth, MAX_DISPLAY_WIDTH)（後方互換）。
 * number 指定時（スマホ連動・§A1）は min(pixelWidth, containerWidth)（従来挙動を維持）。
 * FitOptions 指定時（PY1-1）は横フィット(widthCap)・縦フィット(heightCap)・ズーム(zoom)を反映:
 *   fitW = min(pixelWidth, widthCap, heightCap)、戻り値 = fitW × clampZoom(zoom)。
 *   ③確定: 拡大優先で元画像px を超えてOK（fitW×zoom に上限クランプを付けない・PY1-1）。
 */
export function displayWidth(meta: PageMeta, opts?: number | FitOptions): number {
  const o = normalizeFitOptions(opts)
  const zoom = clampZoom(o.zoom ?? 1)

  // widthCap: 横フィット（既存）。containerWidth 指定時 min(800, cw)、未指定 800。
  const widthCap =
    o.containerWidth && o.containerWidth > 0
      ? Math.min(MAX_DISPLAY_WIDTH, o.containerWidth)
      : MAX_DISPLAY_WIDTH

  // heightCap: ②縦フィット。表示高 ≤ viewportHeight となる表示幅上限
  //   = viewportHeight × (pixelWidth / pixelHeight)。未指定なら Infinity（従来）。
  const heightCap =
    o.viewportHeight && o.viewportHeight > 0
      ? o.viewportHeight * (meta.pixelWidth / meta.pixelHeight)
      : Infinity

  // 原寸 px・横・縦すべての上限の最小（＝全体が画面に収まる最大幅）。
  const fitW = Math.min(meta.pixelWidth, widthCap, heightCap)

  // ③ズーム: フィット幅に zoom を乗算（zoom=1 が全体フィット原点・上限クランプなし）。
  return fitW * zoom
}

/** 表示倍率 = displayWidth / pixelWidth。第2引数は number|FitOptions（後方互換）。 */
export function displayScale(meta: PageMeta, opts?: number | FitOptions): number {
  return displayWidth(meta, opts) / meta.pixelWidth
}

/** 表示高さ = pixelHeight × displayScale。 */
export function displayHeight(meta: PageMeta, opts?: number | FitOptions): number {
  return meta.pixelHeight * displayScale(meta, opts)
}

/** 元画像 px → pt の変換係数（横）。 */
export function pxToPtX(meta: PageMeta): number {
  return meta.widthPt / meta.pixelWidth
}

/** 元画像 px → pt の変換係数（縦）。 */
export function pxToPtY(meta: PageMeta): number {
  return meta.heightPt / meta.pixelHeight
}

/** pt → 表示 px（横）。描画用。第2引数省略時は従来挙動（後方互換）。 */
export function ptToDispX(meta: PageMeta, xPt: number, opts?: number | FitOptions): number {
  return (xPt / meta.widthPt) * displayWidth(meta, opts)
}

/** pt → 表示 px（縦）。描画用。 */
export function ptToDispY(meta: PageMeta, yPt: number, opts?: number | FitOptions): number {
  return (yPt / meta.heightPt) * displayHeight(meta, opts)
}

/** 表示 px → pt（横）。表示 px → 元画像 px（÷displayScale）→ pt（×pxToPtX）。 */
export function dispToPtX(meta: PageMeta, xDisp: number, opts?: number | FitOptions): number {
  return (xDisp / displayScale(meta, opts)) * pxToPtX(meta)
}

/** 表示 px → pt（縦）。 */
export function dispToPtY(meta: PageMeta, yDisp: number, opts?: number | FitOptions): number {
  return (yDisp / displayScale(meta, opts)) * pxToPtY(meta)
}

/**
 * 1px ステップ = 元画像 1px 分の pt（§2-3 / §3）。
 * 表示の縮小に依存せず、元画像 px 基準で一定の pt 量を返す。
 */
export function stepPtX(meta: PageMeta): number {
  return pxToPtX(meta)
}

export function stepPtY(meta: PageMeta): number {
  return pxToPtY(meta)
}

/** 保存時の pt 丸め（小数 SAVE_PT_DECIMALS 桁）。編集中は呼ばない。 */
export function roundPt(value: number): number {
  const f = 10 ** SAVE_PT_DECIMALS
  return Math.round(value * f) / f
}

/** bbox 全体を保存用に丸める。 */
export function roundBbox(b: BboxPt): BboxPt {
  return {
    x: roundPt(b.x),
    y: roundPt(b.y),
    w: roundPt(b.w),
    h: roundPt(b.h),
  }
}

/**
 * bbox がページ範囲（0 ≤ x, 0 ≤ y, x+w ≤ widthPt, y+h ≤ heightPt）内かを判定。
 * 保存バリデーション（§4-2）と一致させるための純関数。
 */
export function isBboxWithinPage(b: BboxPt, meta: PageMeta): boolean {
  return (
    b.x >= 0 &&
    b.y >= 0 &&
    b.w > 0 &&
    b.h > 0 &&
    b.x + b.w <= meta.widthPt + EPS &&
    b.y + b.h <= meta.heightPt + EPS
  )
}

/** 浮動小数の境界比較用の微小許容（丸め由来の境界超過を吸収）。 */
const EPS = 0.01
