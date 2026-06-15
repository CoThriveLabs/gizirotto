/**
 * 白塗り再合成ヘルパ。
 *
 * A500 回避の本体。焼き込み後 `_blank.pdf`（pdf-lib drawRectangle 済）を
 * ラスタライズすると画像 XObject 変質で落ちる（段階0で確定）。そこで画面表示・
 * サムネ経路では「健全な raw PDF をラスタライズした PNG」に、白塗り座標で矩形を
 * **PNG 上に再合成**する。焼き込み PDF はラスタライズ経路に通さず、出力用に温存する。
 *
 * 座標変換（pt → px）は bbox-coords と同一論理（pixelWidth/widthPt 係数）に一本化し、
 * ユニットテストで往復一致を担保する（個人情報死守＝白塗りズレ防止の要）。
 *
 * 依存: @napi-rs/canvas（既存依存・新規ライブラリ 0・$0）。
 */
import type { RasterizedPage } from './pdf-page-rasterizer'
import type { WhiteoutBox } from './whiteout-pipeline'
import { whiteoutBoxToPxRect, type PxRect } from './whiteout-coords'

// 座標変換の純関数・型は @napi-rs/canvas 非依存の共有モジュール whiteout-coords.ts に集約
// （クライアント canvas 版 whiteout-composite-canvas.ts と同一式を共有・式ドリフト禁止・§2-3/§10）。
// 本ファイル（サーバ焼込・@napi-rs/canvas 依存）は座標式を持たず、そこから import して使う。
// 既存 import 互換のため re-export も残す（テスト・他参照が whiteout-composite から取れるように）。
export { whiteoutBoxToPxRect, type PxRect }

/**
 * raw 由来の RasterizedPage（PNG）に、当該ページの白塗り矩形を再合成して
 * 白塗り済 PNG バイトを返す。
 *
 * boxes は全ページぶんを渡してよい（page 番号で当該ページぶんだけ抽出する）。
 * boxes が当該ページに 1 つも無ければ、元 PNG をそのまま返す（無変化＝コスト最小）。
 *
 * 失敗時は例外を投げる（呼び出し側は catch して「素の raw を出さず null 化」する＝
 * 個人情報死守。本関数は握り潰さない）。
 *
 * @param page  raw PDF をラスタライズした 1 ページ（pixelWidth/Height・pagePtSize 付き）
 * @param boxes 白塗り矩形（全ページ可・pt・左上原点）
 * @returns 白塗り済 PNG バイト（image/png）
 */
export async function compositeWhiteoutOnPng(
  page: RasterizedPage,
  boxes: WhiteoutBox[],
): Promise<Uint8Array> {
  const pageBoxes = boxes.filter((b) => b.page === page.page)
  // 当該ページに白塗りが無ければ無変化で返す（再エンコードも省く）。
  if (pageBoxes.length === 0) {
    return page.pngBuffer
  }

  const { loadImage, createCanvas } = await import('@napi-rs/canvas')
  const w = page.pixelWidth
  const h = page.pixelHeight
  const img = await loadImage(page.pngBuffer)
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0, w, h)

  for (const box of pageBoxes) {
    const rect = whiteoutBoxToPxRect(
      box,
      w,
      h,
      page.pagePtSize.width,
      page.pagePtSize.height,
    )
    ctx.fillStyle = `rgb(${rect.r}, ${rect.g}, ${rect.b})`
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h)
  }

  // PNG で再エンコード（@napi-rs/canvas）。型は Buffer だが Uint8Array 互換。
  return canvas.toBuffer('image/png')
}
