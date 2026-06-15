/**
 * 文字サイズ自動統一。
 *
 * 全記入欄 field を「最小記入欄の高さいっぱいに入るサイズ」へ統一する純関数
 * `computeUniformFontSize` を提供する。overlay-generator / image-renderer の両出力経路が
 * **同じ入力 → 同じ uniform** を得て fitTextInBox 呼出前に各 field の既定サイズへ注入する
 * （fitTextInBox 無改修）。
 *
 * 🚨 クライアント/サーバ共有純関数:
 *   - サーバ専用 import（@napi-rs/canvas / pdf-lib / sharp / node:fs 等）を一切持たない。
 *   - フォントメトリクスは `FittableFont`（fitting.ts の純粋インターフェース）の
 *     `heightAtSize` のみを引数で受け取り、外部副作用を持たない。
 *   - これによりブラウザバンドルにネイティブ依存を混入させずクライアントも import 可能。
 *
 * 高さ係数は漢字 em 基準の固定値 `LINE_HEIGHT_RATIO = 1.0` を採用し、fitting.ts の
 * `FIT_HEIGHT_RATIO` と一致させる（両者が同係数でないと uniform を上げても fit が縮め返す）。
 * R / padding / RANGE は実機微調整用に export 定数化。
 */
import type { PdfField, PdfFieldPadding } from '../ai/schemas/pdf-field-schema'
import type { FittableFont, FitTextPadding } from './fitting'
import { FIT_HEIGHT_RATIO } from './fitting'

/**
 * 自動統一サイズの下限（pt）。
 * 既存 font_size_min=8pt より 1pt 上。8pt は「読めるギリギリ」で本文用途には小さい。
 */
export const RANGE_MIN = 9

/**
 * 自動統一サイズの上限（pt）。最小欄基準で 14pt 前後が出る想定に対し、大きい欄混在時も
 * 詰まらないよう余裕を 18pt まで取る。巨大化の最終歯止めは fitTextInBox の自動縮小が担う。
 */
export const RANGE_MAX = 18

/**
 * uniform 算出の高さ係数 R（pt あたりの占有高 em 比）。fitting.ts の FIT_HEIGHT_RATIO と
 * 同一に固定する（= 1.0・漢字 em 基準）。両者が一致していないと uniform を上げても fit が
 * 縮め返す。実機微調整用に export。
 */
export const LINE_HEIGHT_RATIO = FIT_HEIGHT_RATIO

/**
 * uniform 算出時に bbox.h から差し引く上下 padding（pt）。bbox 高さいっぱいに寄せるため
 * 0 を採用（最小欄の上余白を残さない）。field 個別 padding が指定されればそちらが優先。
 *
 * ⚠️ baseline 整合: 描画側（overlay-generator / image-renderer）の uniform 対象 field の
 *   上端揃え padding.top も UNIFORM_PAD_TOP に揃えること（揃えないと uniform を上げても
 *   baseline が field.padding.top 分だけ下がり上余白が残る）。
 */
export const UNIFORM_PAD_TOP = 0
export const UNIFORM_PAD_BOTTOM = 0

/**
 * 「記入欄 uniform が固定テキストサイズと ±閾値 pt 以内なら固定テキストのサイズへスナップ」
 * のデフォルト閾値（pt）。±1.0pt が視覚的に同サイズと知覚される境界。実機微調整用に export。
 */
export const FIXED_TEXT_SNAP_THRESHOLD_PT = 1.0

/**
 * snapToFixedText の外れ値除外帯（pt）。本文っぽい帯 9-14pt に限定し、タイトル等
 * （本文の 1.3 倍以上＝概ね 14pt 超）を母集団から除外して最頻値を取る。実機微調整用に export。
 */
export const FIXED_TEXT_BODY_BAND_MIN_PT = 9
export const FIXED_TEXT_BODY_BAND_MAX_PT = 14

/** computeUniformFontSize に渡すレンジ（既定は RANGE_MIN / RANGE_MAX）。 */
export interface UniformSizeRange {
  min: number
  max: number
}

/**
 * uniform サイズ算出に必要な field の最小限の形（bbox.h と padding のみ参照）。
 * PdfField をそのまま渡せる（構造的部分型）。
 */
export interface UniformSizeField {
  bbox: { h: number }
  padding: PdfFieldPadding
}

/**
 * 1 行テキストが「高さに収まる最大フォントサイズ」を算出する係数 R を返す。
 *
 * 漢字 em 基準の固定係数 `LINE_HEIGHT_RATIO = 1.0`（= fitting.ts の FIT_HEIGHT_RATIO）。
 * fit 側も同係数で枠収まりを判定するため、uniform を上げても fit が縮め返さない。
 *
 * 引数 `font` は後方互換のため受けるが現在は未使用（R は font 非依存の固定定数）。
 * 防御フォールバック（0/負/NaN）は理論上不要だが、将来 R を可変にした場合に備え残す。
 */
export function lineHeightRatio(_font?: FittableFont): number {
  const r = LINE_HEIGHT_RATIO
  return Number.isFinite(r) && r > 0 ? r : 1
}

/**
 * 1 field の「高さに収まる最大 1 行フォントサイズ」を返す。
 *
 * sizeByHeight(f) = (h - pad.top - pad.bottom) / LINE_HEIGHT_RATIO
 *
 * padding 未指定時の上下 pad は field.padding ではなく uniform 専用の `UNIFORM_PAD_TOP/BOTTOM`
 * を使う（bbox 高さいっぱい寄りにするため上下余白を最小化）。padding が明示で渡されれば
 * そちらを優先する。
 *
 * 利用可能高さが 0 以下なら 0 を返す（base = min に取り込まれ、最終 clamp で RANGE_MIN まで
 * 引き上げられる。極小欄は fitTextInBox 自動縮小の安全弁に委ねる）。
 */
export function sizeByHeight(
  field: UniformSizeField,
  ratio: number,
  padding?: FitTextPadding,
): number {
  const padTop = padding ? padding.top : UNIFORM_PAD_TOP
  const padBottom = padding ? padding.bottom : UNIFORM_PAD_BOTTOM
  const usableH = field.bbox.h - padTop - padBottom
  if (usableH <= 0) return 0
  return usableH / ratio
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

/**
 * 記入欄の自動 uniform サイズ（rawPt）が、テンプレ固定テキストのサイズと ±thresholdPt 以内なら
 * 固定テキストのサイズへ「スナップ」させる純関数。
 *
 * 仕様:
 *   1. fixedTextSizesPt から外れ値除外（本文サイズ帯 FIXED_TEXT_BODY_BAND_MIN_PT〜MAX_PT に限定）。
 *      タイトル等の大きい固定テキスト・極小の補助テキストは母集団に入れない。
 *   2. 残りの中から最頻値（mode）を求める。同点時は大きい方を採用（読みやすさ優先）。
 *   3. `|mode - rawPt| <= thresholdPt` のとき mode を返す。閾値外は rawPt をそのまま返す。
 *   4. 母集団が 0 件なら rawPt をそのまま返す（後方互換・snap 無効）。
 *
 * クランプ（RANGE_MIN/MAX）は呼出側（computeUniformFontSize）で snap 戻り値にも効かせる
 * （スナップ後も RANGE クランプを効かせる＝記入欄の極端化防止）。
 *
 * @param rawPt              現行ロジックで算出した uniform サイズ（pt）。
 * @param fixedTextSizesPt   同ページの固定テキスト font.size 群（pt）。空配列で snap 無効。
 * @param thresholdPt        ±閾値（pt）。省略時 FIXED_TEXT_SNAP_THRESHOLD_PT(=1.0)。
 */
export function snapToFixedText(
  rawPt: number,
  fixedTextSizesPt: number[],
  thresholdPt: number = FIXED_TEXT_SNAP_THRESHOLD_PT,
): number {
  if (!Array.isArray(fixedTextSizesPt) || fixedTextSizesPt.length === 0) {
    return rawPt
  }
  // 1. 外れ値除外（本文サイズ帯のみに限定）。
  const filtered: number[] = []
  for (const s of fixedTextSizesPt) {
    if (
      typeof s === 'number' &&
      Number.isFinite(s) &&
      s >= FIXED_TEXT_BODY_BAND_MIN_PT &&
      s <= FIXED_TEXT_BODY_BAND_MAX_PT
    ) {
      filtered.push(s)
    }
  }
  if (filtered.length === 0) return rawPt

  // 2. 最頻値（mode）算出。同点時は大きい方。
  const counts = new Map<number, number>()
  for (const v of filtered) {
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  let mode = filtered[0]
  let bestCount = 0
  for (const [v, c] of counts) {
    if (c > bestCount || (c === bestCount && v > mode)) {
      mode = v
      bestCount = c
    }
  }

  // 3. 閾値判定。
  if (Math.abs(mode - rawPt) <= thresholdPt) {
    return mode
  }
  return rawPt
}

/**
 * 全記入欄 field に適用する統一フォントサイズ（pt）を算出する。
 *
 * アルゴリズム（最小欄基準で全項目同一サイズ）:
 *   1. 各 field の sizeByHeight(f) = (h - pad.top - pad.bottom) / LINE_HEIGHT_RATIO(=1.0)
 *   2. 全記入欄を無条件で母集団に入れる（縦幅最小の日時/場所欄も含める）。
 *   3. base = min over 全記入欄 sizeByHeight(f)（fields 空なら base = RANGE_MIN フォールバック）
 *   4. uniform = clamp(base, RANGE_MIN, RANGE_MAX)
 *      - 極小欄も母集団に入るため base は最小欄基準まで下がる。
 *        極小すぎて clamp 下限を割る分は fitTextInBox の自動縮小が安全弁を担う。
 *
 * @param fields              記入欄のみ（固定テキスト疑似 field は含めない）。空配列なら RANGE_MIN。
 * @param font                フォントメトリクス（heightAtSize のみ参照）。
 * @param padding             field.padding を上書きする個人スタイル padding（field name → padding）。
 * @param range               レンジ（省略時 { min: RANGE_MIN, max: RANGE_MAX }）。
 * @param fixedTextSizesPt    同ページ固定テキスト font.size 群（pt）。指定時のみ snapToFixedText を
 *                            後段に挟む。未指定/空配列なら snap 無効。
 * @param snapThresholdPt     snap の ±閾値（pt）。省略時 FIXED_TEXT_SNAP_THRESHOLD_PT(=1.0)。
 */
export function computeUniformFontSize(
  fields: Array<PdfField | UniformSizeField>,
  font: FittableFont,
  padding?: Record<string, FitTextPadding>,
  range: UniformSizeRange = { min: RANGE_MIN, max: RANGE_MAX },
  fixedTextSizesPt?: number[],
  snapThresholdPt: number = FIXED_TEXT_SNAP_THRESHOLD_PT,
): number {
  const min = range.min
  const max = range.max
  if (fields.length === 0) {
    return clamp(min, min, max)
  }

  const ratio = lineHeightRatio(font)

  // 各 field の sizeByHeight を算出し、全記入欄を無条件で母集団に入れる。
  // 縦幅最小の日時/場所欄も母集団に残すことで base が最小欄基準まで下がり、
  // 全項目がその同一サイズに統一される（最小 bbox 基準）。
  const population: number[] = []
  for (const f of fields) {
    const pad =
      padding && 'name' in f
        ? padding[(f as PdfField).name]
        : undefined
    population.push(sizeByHeight(f, ratio, pad))
  }

  // base = 全記入欄 sizeByHeight の最小（母集団が空のときだけ min フォールバック）。
  const base =
    population.length > 0 ? Math.min(...population) : min

  // 固定テキストサイズへのスナップを後段に挟む。
  //   - fixedTextSizesPt 未指定/空 → snapToFixedText が raw を返す（後方互換）
  //   - スナップ後も RANGE クランプを効かせる（記入欄の極端化防止）
  const snapped = snapToFixedText(base, fixedTextSizesPt ?? [], snapThresholdPt)

  return clamp(snapped, min, max)
}
