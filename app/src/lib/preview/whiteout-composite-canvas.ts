/**
 * 白塗り動的プレビュー・ブラウザ Canvas2D 合成。
 *
 * 白塗りモードのエディタ背景を「raw PNG ＋ 編集中 whiteoutFields のクライアント合成」に
 * するための描画ヘルパ。サーバ焼き込み compositeWhiteoutOnPng（@napi-rs/canvas 依存）は
 * ブラウザで動かないため、座標変換・塗り色の純関数 whiteoutBoxToPxRect を共有し、描画 API
 * だけブラウザ標準 Canvas2D（drawImage / fillStyle / fillRect）で再実装する。
 *
 * 🚨 ズレ禁止（§2-3 / §10）: 座標式は whiteoutBoxToPxRect 1 箇所に集約。本関数は式を
 *   持たず、サーバ焼き込みと同一の純関数を呼ぶ（保存前プレビュー＝最終出力の WYSIWYG）。
 *
 * 削除リアルタイム反映（②本命 UX）: 合成入力は DB ではなく編集中の boxes（whiteoutFields
 *   ＋ meta から組む）。削除すると boxes から外れ、その矩形を塗らない＝元の文字が透ける。
 */
import type { WhiteoutBox } from '@/lib/parsers/pdf/whiteout-pipeline'
// 座標式は @napi-rs/canvas 非依存の共有モジュールから import（サーバ焼込と同一式・式ドリフト禁止）。
// whiteout-composite.ts 経由だと @napi-rs/canvas がクライアントバンドルに混入するため直接 import する（#16）。
import { whiteoutBoxToPxRect } from '@/lib/parsers/pdf/whiteout-coords'

/**
 * raw 背景画像（このページ分）の上に、現在の白塗り boxes を Canvas2D で合成する。
 *
 * canvas の backing store は raw 画像のネイティブ px（pixelWidth × pixelHeight）に揃える。
 * whiteoutBoxToPxRect はこのネイティブ px 空間へ pt を写すので、サーバ焼き込み（同一 px 空間）
 * と一致する。canvas の CSS 表示サイズ（dispW/dispH への縮小）は呼び出し側で行う（座標非破壊）。
 *
 * boxes は当該ページ分だけ渡す前提（呼び出し側で page フィルタ済み）。空なら raw をそのまま描く
 * （＝白塗りを全削除した瞬間に元の文字が全面で透ける）。
 *
 * @param canvas      描画先 canvas（backing store は呼び出し側で pixelWidth/Height に設定済み）
 * @param rawImage    raw 背景の描画ソース（HTMLImageElement / ImageBitmap）
 * @param boxes       当該ページの白塗り矩形（pt・左上原点）
 * @param pixelWidth  raw PNG の幅 px（canvas backing と一致）
 * @param pixelHeight raw PNG の高さ px
 * @param widthPt     PDF ページ幅 pt
 * @param heightPt    PDF ページ高 pt
 */
export function compositeWhiteoutOnCanvas(
  canvas: HTMLCanvasElement,
  rawImage: CanvasImageSource,
  boxes: WhiteoutBox[],
  pixelWidth: number,
  pixelHeight: number,
  widthPt: number,
  heightPt: number,
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  // 毎フレーム全面再描画（前フレームの塗り残骸を残さない＝移動/削除で残像を出さない）。
  ctx.clearRect(0, 0, pixelWidth, pixelHeight)
  ctx.drawImage(rawImage, 0, 0, pixelWidth, pixelHeight)

  for (const box of boxes) {
    const rect = whiteoutBoxToPxRect(box, pixelWidth, pixelHeight, widthPt, heightPt)
    // 不透明塗り（焼き込みと同じく完全被覆＝個人情報を残さない）。
    ctx.fillStyle = `rgb(${rect.r}, ${rect.g}, ${rect.b})`
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h)
  }
}
