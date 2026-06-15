/**
 * 固定テキスト動的プレビュー・ブラウザ Canvas2D 合成。
 *
 * 「raw 背景 + クライアント canvas 合成」方式。本ファイルはその描画ヘルパ。
 *
 * 🚨 ズレ最小化: フォントメトリクスの最終真実は overlay PDF 出力経路の fitTextInBox（pdf-lib）。
 *   プレビューは ctx.measureText 近似の WYSIWYG（微小ズレ許容）。
 *   サムネ焼き込み fixedtext-composite.ts（@napi-rs/canvas / GlobalFonts）と同型ポリシーで描画する。
 *
 * 削除リアルタイム反映: 合成入力は編集中の固定テキスト配列。削除/value 変更すると即その状態が
 *   canvas に反映される（焼き込みのような「再編集不可」問題は構造的に起きない）。
 */
import type { FixedText } from '@/lib/pdf-output/fixedtext-adapter'
import { layoutFixedTextLines } from '@/lib/pdf-output/fixedtext-draw'

/**
 * 当該ページの固定テキストを Canvas2D で上書き描画する純関数。
 *
 * 呼び出し側は背景（raw + 白塗り合成済）を canvas に drawImage 済みの状態で本関数を呼ぶ。
 * 本関数は clearRect / drawImage は行わず、既存の canvas 内容の上に fillText を重ねるだけ。
 * （= 白塗りモード canvas との合成順を呼出側で「背景 → 白塗り → 固定テキスト」に保てる）。
 *
 * texts は当該ページ分だけ渡す前提（呼び出し側で page フィルタ済み）。空なら何もしない。
 *
 * @param canvas      描画先 canvas（backing store は pixelWidth × pixelHeight 設定済み前提）
 * @param texts       当該ページの固定テキスト配列（pt・左上原点）
 * @param pixelWidth  raw PNG の幅 px（canvas backing と一致）
 * @param pixelHeight raw PNG の高さ px
 * @param widthPt     PDF ページ幅 pt
 * @param heightPt    PDF ページ高 pt
 */
export function compositeFixedTextsOnCanvas(
  canvas: HTMLCanvasElement,
  texts: FixedText[],
  pixelWidth: number,
  pixelHeight: number,
  widthPt: number,
  heightPt: number,
): void {
  if (texts.length === 0) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const sx = pixelWidth / widthPt
  const sy = pixelHeight / heightPt

  ctx.save()
  ctx.fillStyle = '#000000'
  ctx.textBaseline = 'top'

  for (const ft of texts) {
    const value = ft.value ?? ''
    if (value.trim() === '') continue
    const fontPx = Math.max(1, ft.font.size * sy)
    // bbox 縦横中央配置（2026-06-14）: layoutFixedTextLines に h（px 換算）も渡す。
    const bboxPx = {
      x: ft.bbox.x * sx,
      y: ft.bbox.y * sy,
      w: ft.bbox.w * sx,
      h: ft.bbox.h * sy,
    }
    const drawLines = layoutFixedTextLines(
      value,
      bboxPx,
      fontPx,
      (text, size) => {
        ctx.font = `${size}px "NotoSansJP", sans-serif`
        return ctx.measureText(text).width
      },
    )
    for (const dl of drawLines) {
      ctx.font = `${dl.drawSize}px "NotoSansJP", sans-serif`
      ctx.fillText(dl.text, dl.xPt, dl.topYPt)
    }
  }

  ctx.restore()
}
