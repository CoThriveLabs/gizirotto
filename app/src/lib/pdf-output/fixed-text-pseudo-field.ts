/**
 * FixedText → 疑似 PdfField 変換ヘルパ（regenerate-minute-pdf.ts / render-image/route.ts /
 * minute-thumbnail.ts の 3 経路から共有する純関数）。
 *
 * minute-thumbnail.ts ↔ regenerate-minute-pdf.ts の循環 import を避けるため、
 * 共有純関数を独立モジュールへ切り出した。
 *
 * 設計判断（2026-06-14 中央配置対応で改訂）:
 * - 旧仕様（v1.7）では改行ごとに独立 pseudo field（`__L${i}`）へ展開し、各行の bbox.h を
 *   `fontSize / RATIO`（1 行ぶん）に上書きしていた。これは fitTextInBox を通していた頃の
 *   名残で、現仕様（`layoutFixedTextLines` が内部で `\n` 分割する）では二重処理となり、
 *   さらに **元 FixedText.bbox.h が呼出元から失われ縦中央配置ができない**問題があった。
 * - 新仕様（2026-06-14）: **行展開せず常に 1 件の pseudo field**（name = 元 ft.name・bbox =
 *   元 ft.bbox そのまま・value は改行込み）を返す。`\n` 分割は下流の `layoutFixedTextLines`
 *   が一手に担い、bbox.h を保持したまま縦横中央配置を計算する。
 * - 後方互換: overlay-generator / image-renderer の `isFixedText` 分岐は `layoutFixedTextLines`
 *   経由なので value に `\n` が含まれても問題なく動く。記入欄経路（fitTextInBox）には
 *   そもそも固定テキスト pseudo field は流れないため影響なし。
 * - 空 value の FixedText は何も出力しない（呼出側で空 value は既に弾く前提だが二重防御）。
 */
import type { PdfField } from '../ai/schemas/pdf-field-schema'
import { NEW_FIELD_DEFAULTS, buildPdfFieldFromDefaults } from './bbox-save'
import type { FixedText } from './fixedtext-adapter'

/**
 * FixedText を overlay 用の疑似 PdfField に変換（C-2・§3-3）。
 * label/type/max_chars/padding 等は NEW_FIELD_DEFAULTS で補完。
 * font は FixedText.font を優先し、family/size の欠損のみ NEW_FIELD_DEFAULTS.font で補完する。
 */
function fixedTextToPseudoField(ft: FixedText): PdfField {
  const family =
    ft.font && typeof ft.font.family === 'string' && ft.font.family
      ? ft.font.family
      : NEW_FIELD_DEFAULTS.font.family
  const size =
    ft.font && typeof ft.font.size === 'number' && ft.font.size > 0
      ? ft.font.size
      : NEW_FIELD_DEFAULTS.font.size
  return buildPdfFieldFromDefaults({
    name: ft.name,
    label: ft.value, // overlay は label を描画に使わないが PdfField 必須のため value を流用
    bbox: { ...ft.bbox },
    font: { family, size },
  })
}

/**
 * FixedText を overlay 用の単一 pseudo field（改行込み value）に変換する。
 *
 * v1.7 までの「行ごと `__L${i}` 展開」は撤廃（2026-06-14 中央配置対応）。
 * 改行分割は下流の `layoutFixedTextLines` が担い、元 ft.bbox（h 含む）をそのまま保持する。
 * 既存呼出側（render-image / minute-thumbnail / regenerate-minute-pdf）は配列前提のまま
 * 動作させるため、結果は常に長さ 0 または 1 の配列で返す（API 互換）。
 */
export function fixedTextToPseudoFieldsByLines(
  ft: FixedText,
): Array<{ field: PdfField; value: string }> {
  const value = ft.value ?? ''
  if (value === '') return []
  return [{ field: fixedTextToPseudoField(ft), value }]
}
