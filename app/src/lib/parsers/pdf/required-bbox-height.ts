/**
 * bbox.h 自動連動の核心となる純関数（段階 2-D4・
 * 設計書 minutes_adjust_editor_renewal_design_2026-06-08 §1-2-6-1-1 / §2-4-1）。
 *
 * 「テキスト内容 + fontSize + フォント + padding」から、テキストが行内に収まるのに
 * **必要な bbox.h（pt）** を算出する。AdjustView が fontSize 変更 / textarea 編集 /
 * マウント時 / 自動サイズに戻す の 4 経路で本関数を呼び、`bbox_overrides[name].h` を
 * 自動更新する（§2-4-1）。
 *
 * 🚨 サーバ専用 import 分離（§3-5 / mistake.md 2026-06-06 致命傷の教訓）:
 *   - `@napi-rs/canvas` / `pdf-lib` / `fontkit` / `sharp` / `node:fs` / `node:path` を
 *     一切 import しない。
 *   - `fitting.ts` の `wrapText` / `FIT_HEIGHT_RATIO` / `FittableFont` のみ参照。
 *   - これにより AdjustView（クライアント）と PDF / canvas 経路の両方から呼べる pure。
 *
 * 算出式（§1-2-6-1-1・v2.4.1 A 式: 最終行 GAP 除外）:
 *   ```
 *   maxW          = max(0, bbox.w - padding.left - padding.right)
 *   lineCount     = Σ paragraphs.map(p => wrapText(p, maxW, font, fontSize).length)
 *                   （空段落は 1 行ぶん・全文空の場合も最低 1 行確保）
 *   lineHeightPt  = fontSize * FIT_HEIGHT_RATIO(=1.0) * LINE_GAP_MULT(=1.2)
 *   requiredH     = fontSize * FIT_HEIGHT_RATIO
 *                 + (lineCount - 1) * lineHeightPt
 *                 + padTop + padBottom
 *   ```
 *   - 1 行: `requiredH = fontSize + padTop + padBottom`（「文字サイズぴったり」方針）
 *   - N 行: `requiredH = fontSize + (N-1) * fontSize * 1.2 + padTop + padBottom`
 *     （行間 1.2 維持・最終行の余分な GAP のみ除外）
 *
 * LINE_GAP_MULT(1.2) は以下と同係数:
 *   - fitting.ts L205 `lineHeight = lineExtent(...) * 1.2`
 *   - fitting.ts L318 `lineHeight = lineExtent(...) * 1.2`
 *   - field-values-composite-canvas.ts L89 `LINE_GAP_MULT = 1.2`
 *   - overlay-generator.ts L268 `lineHeight = fontHeight * 1.2`
 *   - image-renderer.ts L529 `lineHeightPt = fontHeightPt * 1.2`
 *
 * したがって本関数の出力 h を bbox_overrides に詰めれば、PDF / canvas どちらの経路でも
 * **必要行数ぶんの描画スペースが構造的に確保される**（高さ判定スキップが発生しない）。
 *
 * 短文 field 消失問題への効果（§0-8 / §1-1-0-D）:
 *   `effective bbox.h = requiredH = lineCount × lineHeightPt + padTop + padBottom` で
 *   override.fontSize 経路でも常に必要分が確保されるため、`maxHPx = bbox.h × sy - effPad × sy
 *   = lineCount × lineHeightPt × sy ≥ lineExtentPx × lineCount` で全行収まる
 *   → canvas 高さ判定スキップが構造的に発生しない（短文 field 消失問題は bbox.h 連動で構造解決）。
 */
import {
  wrapText,
  FIT_HEIGHT_RATIO,
  type FittableFont,
} from '@/lib/pdf-output/fitting'
import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'

/**
 * 行間係数。fitting.ts / field-values-composite-canvas.ts / overlay-generator.ts /
 * image-renderer.ts と一致させる（PDF / canvas / overlay 全経路で同係数 = 完全一致前提）。
 */
export const LINE_GAP_MULT = 1.2

/**
 * テキストが必要とする bbox.h（pt）を算出する純関数。
 *
 * @param field    PdfField（bbox.w / padding を参照。bbox.h は出力で上書きされる前提なので参照不要）
 * @param value    現在の入力値（textarea 内容・改行 `\n` 込み）
 * @param fontSize 現在の effective fontSize（pt）。`override.fontSize ?? uniform ?? field.font.size` を呼出側で解決済み。
 * @param font     `FittableFont` 構造的部分型。previewFont（opentype.js）/ fontkit / fallback ctx.measureText アダプタ何でも可
 * @returns        テキストが収まるのに必要な bbox.h（pt・padTop/Bottom 込み）。常に 1 行ぶん以上を返す。
 */
export function computeRequiredBboxHeight(
  field: PdfField,
  value: string,
  fontSize: number,
  font: FittableFont,
): number {
  const padTop = field.padding?.top ?? 0
  const padBottom = field.padding?.bottom ?? 0
  const padLeft = field.padding?.left ?? 0
  const padRight = field.padding?.right ?? 0
  const maxW = Math.max(0, field.bbox.w - padLeft - padRight)

  // 段落分割（明示改行 \n を尊重・空段落も 1 行ぶんとして高さに含める）。
  // fitting.ts fitMultiline（L279）と同パターン: `text.split('\n')` で段落単位に分け、
  // 段落ごとに wrapText で wrap 行数を算出する。
  const paragraphs = value.split('\n')
  let lineCount = 0
  for (const para of paragraphs) {
    if (para === '') {
      lineCount += 1 // 空行も 1 行ぶん（高さ送りのみ）
      continue
    }
    if (maxW <= 0) {
      // 防御: bbox.w が padding 未満で maxW=0 の場合、wrapText が無限ループになりうるため
      // 段落丸ごと 1 行扱いとする（描画は overflow で諦める・上位レイヤで警告）。
      lineCount += 1
      continue
    }
    const wrapped = wrapText(para, maxW, font, fontSize)
    lineCount += wrapped.length
  }
  // 値が完全空 / 段落分割が空配列など、結果 0 行になった場合も最低 1 行確保（textarea 高さ確保）。
  if (lineCount === 0) lineCount = 1

  // 1 行の占有高（pt）= fontSize × FIT_HEIGHT_RATIO(1.0) × LINE_GAP_MULT(1.2)
  // fitting.ts L205 / L318 と同型（PDF 経路と完全一致）。
  const lineHeightPt = fontSize * FIT_HEIGHT_RATIO * LINE_GAP_MULT

  // v2.4.1 A 式: 最終行は GAP を加算しない（ユーザー実機フィードバック 1「ぴったり希望」対応）。
  //   最初の行: fontSize × FIT_HEIGHT_RATIO（行の本体・GAP なし）
  //   残り (lineCount - 1) 行: 各 lineHeightPt（行間 1.2 を含む送り）
  return (
    fontSize * FIT_HEIGHT_RATIO +
    (lineCount - 1) * lineHeightPt +
    padTop +
    padBottom
  )
}
