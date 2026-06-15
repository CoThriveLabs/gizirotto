/**
 * 白紙 A4 PNG プレースホルダ生成。
 *
 * 用途:
 *   builtin テンプレ等で source PDF が無い場合に、render-image / bbox-editor の
 *   背景プレースホルダとして AdjustView へ返す。
 *
 * 設計判断:
 *   - pdfjs / pdf-lib を経由しない（A500 系経路を踏まない）。
 *   - @napi-rs/canvas で純粋に矩形を白塗りした PNG を作るだけ。
 *   - A4 = 595 x 842 pt。dpi に応じて pixel サイズを決定（scale = dpi / 72）。
 */

const A4_WIDTH_PT = 595
const A4_HEIGHT_PT = 842

export interface BlankA4PngResult {
  bytes: Uint8Array
  widthPx: number
  heightPx: number
  widthPt: number
  heightPt: number
}

/**
 * 白紙 A4 PNG を 1 枚返す。
 * @param dpi 出力解像度（72-300 想定、呼出側で clamp 済前提）
 */
export async function generateBlankA4Png(dpi: number): Promise<BlankA4PngResult> {
  const { createCanvas } = await import('@napi-rs/canvas')
  const scale = dpi / 72
  const widthPx = Math.ceil(A4_WIDTH_PT * scale)
  const heightPx = Math.ceil(A4_HEIGHT_PT * scale)
  const canvas = createCanvas(widthPx, heightPx)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, widthPx, heightPx)
  const bytes = new Uint8Array(canvas.toBuffer('image/png'))
  return {
    bytes,
    widthPx,
    heightPx,
    widthPt: A4_WIDTH_PT,
    heightPt: A4_HEIGHT_PT,
  }
}
