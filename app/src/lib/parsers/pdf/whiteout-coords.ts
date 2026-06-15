/**
 * 白塗り座標変換の共有純関数。
 *
 * 🚨 サーバ／クライアント共有モジュール（@napi-rs/canvas 等のサーバ専用依存に一切触れない）:
 *   - サーバ焼き込み: whiteout-composite.ts（compositeWhiteoutOnPng）が本ファイルを import。
 *   - ブラウザ動的プレビュー: whiteout-composite-canvas.ts（compositeWhiteoutOnCanvas）が import。
 *
 *   両者が同一の whiteoutBoxToPxRect を使うことで、保存前プレビュー（client）と最終出力
 *   （server 焼込）の座標・塗り色が一致する＝WYSIWYG。式を二重定義するとズレ＝個人情報の
 *   白塗りズレに直結するため、座標変換・塗り色の式はここ 1 箇所に集約する（式ドリフト禁止・§10）。
 *
 *   本ファイルは型（WhiteoutBox）と算術のみで、Node.js ネイティブモジュール（@napi-rs/canvas）を
 *   import しない。これによりクライアントバンドルにサーバ専用 binary が混入しない
 *   （Build Error: Node.js binary module 回避・タスク #16）。
 */
import type { WhiteoutBox } from './whiteout-pipeline'

/** px 空間の塗り矩形（整数化前の float）。テスト可能なように純関数で算出する。 */
export interface PxRect {
  x: number
  y: number
  w: number
  h: number
  /** 塗り色（0-255）。estimatedBgColor をそのまま反映。 */
  r: number
  g: number
  b: number
}

/**
 * WhiteoutBox（左上原点・pt）を、当該ページのラスタ PNG の px 矩形へ変換する純関数。
 *
 * pt → px のスケールは bbox-coords の pxToPtX/Y（= widthPt/pixelWidth）の逆数:
 *   sx = pixelWidth / widthPt, sy = pixelHeight / heightPt
 * PDF/PNG ともに左上原点なので y 反転は不要（焼き込みの drawRectangle は左下原点だが、
 * ここは画像座標系なのでそのまま乗算でよい）。
 *
 * @param box        当該ページの白塗り矩形（pt・左上原点）
 * @param pixelWidth  ラスタ PNG の幅 px
 * @param pixelHeight ラスタ PNG の高さ px
 * @param widthPt     PDF ページ幅 pt
 * @param heightPt    PDF ページ高 pt
 */
export function whiteoutBoxToPxRect(
  box: WhiteoutBox,
  pixelWidth: number,
  pixelHeight: number,
  widthPt: number,
  heightPt: number,
): PxRect {
  const sx = pixelWidth / widthPt
  const sy = pixelHeight / heightPt
  return {
    x: box.bbox.x * sx,
    y: box.bbox.y * sy,
    w: box.bbox.w * sx,
    h: box.bbox.h * sy,
    r: box.estimatedBgColor.r,
    g: box.estimatedBgColor.g,
    b: box.estimatedBgColor.b,
  }
}
