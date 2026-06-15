/**
 * ドラッグ中の軽量レイヤ描画ヘルパ。
 *
 * bbox ドラッグ中、重い背景フル再合成（compositeWhiteoutOnCanvas の全面 drawImage = 約200万px /
 * 全 field opentype.js wrap）を毎フレーム走らせる代わりに、freeze 時に 1 回だけ撮った背景
 * スナップ（ImageBitmap / HTMLCanvasElement）を貼り直し、移動中の 1 field だけを軽量に再描画する。
 *
 * 🚨 pure（@napi-rs/canvas / pdf-lib / sharp / node:fs 等のサーバ専用 import 禁止・whiteout-coords /
 *   whiteout-composite-canvas / field-values-composite-canvas と同じ方針）。ブラウザ標準 Canvas2D
 *   と既存の純関数のみを使う。これによりクライアントバンドルにサーバ専用 binary が混入しない（#16）。
 *
 * 🚨 式ドリフト禁止: 座標式・塗り色式・記入値描画は自作しない。
 *   - 白塗り矩形: whiteout-coords.ts の whiteoutBoxToPxRect（サーバ焼込と共有・WYSIWYG）。
 *   - 記入値:     field-values-composite-canvas.ts の compositeFieldValuesOnCanvas（items=1 で呼ぶ）。
 *   drop 時の従来フル合成と同一純関数を通すので、drag 中の見た目 = drop 後の見た目（ガタつき禁止）。
 */
import { whiteoutBoxToPxRect } from '@/lib/parsers/pdf/whiteout-coords'
import {
  compositeFieldValuesOnCanvas,
  type FieldValueComposite,
  type FieldValueCompositeOptions,
} from './field-values-composite-canvas'
import type { WhiteoutBox } from '@/lib/parsers/pdf/whiteout-pipeline'

/**
 * 背景スナップを canvas 全面に貼る（freeze 直後 / drag 中の各フレームの土台）。
 *
 * snapshot は freeze 時に撮った「移動 field を除いた背景」（raw + 白塗り + 固定テキスト + 他 field の
 * 記入値まで合成済み）を想定する。全面貼り直すことで前フレームの move field 残骸を消す（素朴実装）。
 * snapshot は ImageBitmap でも HTMLCanvasElement でも drawImage で受けられる（fallback 両対応・§5）。
 *
 * canvas backing は呼出側で pixelWidth × pixelHeight に設定済み前提（whiteoutBoxToPxRect の写像先と一致）。
 *
 * @param ctx          描画先の 2D コンテキスト
 * @param snapshot     背景スナップ（ImageBitmap / HTMLCanvasElement）
 * @param pixelWidth   canvas backing 幅 px
 * @param pixelHeight  canvas backing 高さ px
 */
export function paintBackgroundSnapshot(
  ctx: CanvasRenderingContext2D,
  snapshot: ImageBitmap | HTMLCanvasElement,
  pixelWidth: number,
  pixelHeight: number,
): void {
  ctx.clearRect(0, 0, pixelWidth, pixelHeight)
  ctx.drawImage(snapshot, 0, 0, pixelWidth, pixelHeight)
}

/** paintDraggingField の追加オプション（記入値描画 opts + 任意の白塗り）。 */
export interface PaintDraggingFieldOptions extends FieldValueCompositeOptions {
  /**
   * 移動 field の新位置に先に塗る白塗り矩形（pt・左上原点）。whiteout variant 共有時や、
   * 記入値の下を被覆したいときに渡す。adjust（variant='field'）では白塗りは背景 raw に
   * 焼込済なので通常は省略する（= 記入値 fillText のみ・drop 後のフル合成と同一の見た目）。
   * 座標・塗り色は whiteoutBoxToPxRect（サーバ焼込と共有式）で算出する＝式ドリフトゼロ。
   */
  whiteoutBox?: WhiteoutBox
}

/**
 * 背景スナップを土台に、移動中の 1 field だけを軽量描画する。
 *
 * 手順:
 *   1. paintBackgroundSnapshot で背景を全面貼り直す（元位置の move field を消去）。
 *   2. （任意）whiteoutBox があれば whiteoutBoxToPxRect で算出した矩形を新位置に塗る。
 *   3. compositeFieldValuesOnCanvas を items=[movingField]（1 件のみ）で呼び記入値を描く。
 *      wrap は移動中まったく不変（x/y のみ変化）なので memoWrap が効き opentype.js 呼び出しは
 *      実質ゼロ。1 件のみなので O(N²) は最小。
 *
 * movingField は override に最新の x/y/w/h を反映した状態で渡す前提（呼出側が pointermove で更新）。
 * compositeFieldValuesOnCanvas は内部で applyFieldOverride を通すため、override を最新化すれば
 * 新位置に正しく描かれる（座標式は同関数に集約・自作しない）。
 *
 * @param ctx          描画先の 2D コンテキスト
 * @param snapshot     背景スナップ（移動 field を除いた背景）
 * @param movingField  移動中の 1 field（field + value + 最新 override）
 * @param pixelWidth   canvas backing 幅 px
 * @param pixelHeight  canvas backing 高さ px
 * @param widthPt      PDF ページ幅 pt
 * @param heightPt     PDF ページ高 pt
 * @param options      記入値描画オプション（uniformFontSize / previewFont 等）＋任意 whiteoutBox
 */
export function paintDraggingField(
  ctx: CanvasRenderingContext2D,
  snapshot: ImageBitmap | HTMLCanvasElement,
  movingField: FieldValueComposite,
  pixelWidth: number,
  pixelHeight: number,
  widthPt: number,
  heightPt: number,
  options?: PaintDraggingFieldOptions,
): void {
  // 1. 背景を全面貼り直す（元位置消去）。
  paintBackgroundSnapshot(ctx, snapshot, pixelWidth, pixelHeight)

  // 2. （任意）白塗り矩形。座標・色は whiteoutBoxToPxRect（サーバ焼込と共有式）。
  const whiteoutBox = options?.whiteoutBox
  if (whiteoutBox) {
    const rect = whiteoutBoxToPxRect(
      whiteoutBox,
      pixelWidth,
      pixelHeight,
      widthPt,
      heightPt,
    )
    ctx.fillStyle = `rgb(${rect.r}, ${rect.g}, ${rect.b})`
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h)
  }

  // 3. 記入値（1 件のみ）。compositeFieldValuesOnCanvas は canvas を引数に取るので、
  //    ctx.canvas（描画先 canvas 本体）を渡す。内部で clearRect/drawImage はせず重ね描き。
  if (movingField.value && movingField.value.trim() !== '') {
    // whiteoutBox は paintDraggingField 固有の拡張オプションなので、記入値合成へは渡さない。
    const fvOptions: FieldValueCompositeOptions | undefined = options
      ? {
          ...(options.uniformFontSize !== undefined
            ? { uniformFontSize: options.uniformFontSize }
            : {}),
          ...(options.fillStyle !== undefined ? { fillStyle: options.fillStyle } : {}),
          ...(options.fontFamily !== undefined
            ? { fontFamily: options.fontFamily }
            : {}),
          ...(options.previewFont ? { previewFont: options.previewFont } : {}),
        }
      : undefined
    compositeFieldValuesOnCanvas(
      ctx.canvas,
      [movingField],
      pixelWidth,
      pixelHeight,
      widthPt,
      heightPt,
      fvOptions,
    )
  }
}
