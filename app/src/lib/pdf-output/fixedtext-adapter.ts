/**
 * FixedText ⇔ EditorField アダプタ。
 *
 * 固定テキスト（会議名・参加者など常時同一値）と bbox-pane が扱う EditorField を
 * 相互変換する純関数。whiteout-adapter.ts を下敷きに同ポリシーで実装する。
 *
 * 両者とも座標系は「左上原点・pt」で同一のため、座標は**無変換の詰め替えのみ**
 * （変換を挟まない＝ズレ温床ゼロ）。
 *
 * FixedText 固有の属性（value / font）は EditorField に乗らないので side table（Map）で
 * 保持し、保存（fieldsToFixedTexts）時に再合流する。EditorField.label には value を載せて
 * 編集 UI 上で何の固定テキストかを判別できるようにする（whiteout は label 空だが、固定
 * テキストは値ありが本質＝label に value を出す）。
 *
 * 命名: 合成 name `ft_N`（FIXEDTEXT_NAME_PREFIX='ft_'）を index ベースで採番する。
 *       記入欄 `field_N` / 白塗り `wo_N` と三者非衝突。
 */
import type { EditorField } from './whiteout-adapter'
import { NEW_FIELD_DEFAULTS } from './bbox-save'
import { MIN_BBOX_PT } from './bbox-coords'

/** 固定テキスト要素の永続型（templates.fixed_texts jsonb の要素）。 */
export interface FixedText {
  /** 合成 name。記入欄 field_N / 白塗り wo_N と非衝突の ft_N。 */
  name: string
  /** 固定表示テキスト（テンプレ固定値）。 */
  value: string
  /** 左上原点 pt の配置矩形。 */
  bbox: { page: number; x: number; y: number; w: number; h: number }
  /** 描画フォント（family/size）。 */
  font: { family: string; size: number }
}

/** FixedText 固有属性の side table 値（EditorField に乗らない value/font）。 */
export interface FixedTextMeta {
  value: string
  font: { family: string; size: number }
}

/** 合成 name の接頭辞（記入欄 field_N / 白塗り wo_N と衝突しない）。 */
const FIXEDTEXT_NAME_PREFIX = 'ft_'

/**
 * 固定テキスト font.size の高さ比（設計書 v1.3 §3-2-1・案ア）。
 * `font.size := bbox.h * FIXED_TEXT_FONT_SIZE_RATIO` を第一義とし、横溢れ時のみ縮小ガード。
 * 0.7／0.8／0.9 の調整余地としてここ 1 点に集約（プレビュー px・出力 pt が共有）。
 */
export const FIXED_TEXT_FONT_SIZE_RATIO = 0.8

/**
 * bbox から固定テキストの font.size を算出する（設計書 v1.3 §3-2-1・案ア）。
 *
 * 第一義: `bbox.h * FIXED_TEXT_FONT_SIZE_RATIO`（高さ基準）。value の有無を問わず常に引ける。
 * 横溢れガード（縮小のみ）: 高さ基準サイズで value を描いた推定横幅が bbox.w を超える場合に限り、
 *   横に収まる最大サイズへ縮小する（拡大はしない＝高さ基準を超えない）。
 *
 * フォントメトリクスの厳密値は出力経路（generateOverlayPdf の fitText）が最終真実だが、
 * ここでは依存ゼロの近似（CJK 1 文字 ≒ 1em 角・半角 ≒ 0.5em）で横幅を見積もる。
 * プレビュー(px)・保存(pt) ともにこの同一式を使い乖離を最小化する（§3-2-5）。
 *
 * @param bbox  対象 bbox（pt）
 * @param value 表示テキスト（空なら高さ基準値をそのまま返す）
 */
/**
 * テキストの近似 em 数（横幅見積もり用・単一ソース・§3-2-1c）。
 * 半角/数字 ≒ 0.5em・それ以外（CJK 等）≒ 1em。`computeFixedTextFontSize` と
 * `bboxWidthFromValue`（v1.6）が共有し、em 換算を二重定義しない。
 */
export function textEmUnits(value: string): number {
  const text = value ?? ''
  let emUnits = 0
  for (const ch of text) {
    emUnits += /[\x00-\xff]/.test(ch) ? 0.5 : 1
  }
  return emUnits
}

/**
 * value の行数（v1.7 §3-2-1d・改行対応）。
 * `\n` で分割した行数（空 value は 1 行扱い・最低 1）。`\r\n` は `\n` に正規化済前提
 * （UI 側 textarea は `\n` 区切りで来る）。
 */
export function countFixedTextLines(value: string): number {
  const text = value ?? ''
  if (text === '') return 1
  return text.split('\n').length
}

export function computeFixedTextFontSize(
  bbox: { w: number; h: number },
  value: string,
): number {
  // v1.7: 改行対応。1 行あたりの高さ基準 = (bbox.h / N) * RATIO。
  // 横溢れガードは最長行（em 最大）に対して評価する。
  const lines = (value ?? '').split('\n')
  const n = Math.max(1, lines.length)
  const heightBased = (bbox.h / n) * FIXED_TEXT_FONT_SIZE_RATIO
  const text = value ?? ''
  if (text.trim() === '') return heightBased
  // 最長行の em 数で横溢れ判定（複数行は行ごとに独立 fit）。
  let maxEm = 0
  for (const line of lines) {
    const em = textEmUnits(line)
    if (em > maxEm) maxEm = em
  }
  if (maxEm <= 0) return heightBased
  const estWidth = heightBased * maxEm
  if (estWidth <= bbox.w) return heightBased
  return bbox.w / maxEm
}

/**
 * bbox.w 左右余白の font.size 比（v1.6 §3-2-1c）。`width := emUnits*fontSize + fontSize*RATIO`。
 * 0.3 を 1 点定義（文字が枠ギリギリにならない最小限の余白）。
 */
export const FIXED_TEXT_WIDTH_PADDING_RATIO = 0.3

/**
 * value（文字数）と font.size から bbox.w を算出する（v1.6 §3-2-1c・案E＝文字長→幅連動）。
 *
 * `width := textEmUnits(value) * fontSize + fontSize * FIXED_TEXT_WIDTH_PADDING_RATIO`。
 * em 係数は `computeFixedTextFontSize` と共有（`textEmUnits`）＝二重定義しない。
 * 空 value（trim 後）は文字幅 0 だが、枠が潰れないよう **最小幅 `MIN_BBOX_PT`** を維持する。
 *
 * 用途: value 編集時・大きさボタン ± 時の bbox.w 再算出。出力（overlay）は font.size を反映する
 * ため、bbox.w が広がっても出力経路は無改修（プレビュー幅と実出力は em 近似のため微小ズレ許容）。
 *
 * @param value    表示テキスト
 * @param fontSize 文字サイズ（pt）
 */
export function bboxWidthFromValue(value: string, fontSize: number): number {
  // v1.7: 改行対応。複数行は最長行で幅を決める（各行はそれぞれ fit 表示される）。
  const lines = (value ?? '').split('\n')
  let maxEm = 0
  for (const line of lines) {
    const em = textEmUnits(line)
    if (em > maxEm) maxEm = em
  }
  const padding = fontSize * FIXED_TEXT_WIDTH_PADDING_RATIO
  const width = maxEm * fontSize + padding
  return Math.max(MIN_BBOX_PT, width)
}

/**
 * value と font.size から bbox.h を算出する（v1.7 §3-2-1d・改行対応）。
 *
 * `height := N * (fontSize / RATIO)` ＝ 1 行あたり `fontSize / RATIO` を N 行ぶん。
 * 双方向不変条件は 1 行あたりで成立：`fontSize = (bbox.h / N) * RATIO`。
 *
 * 用途: value 編集時に改行数が変わった場合の bbox.h 再算出。空 value は N=1 として扱う。
 *
 * @param value    表示テキスト（`\n` 区切り）
 * @param fontSize 文字サイズ（pt）
 */
export function bboxHeightFromValue(value: string, fontSize: number): number {
  const n = countFixedTextLines(value)
  return n * (fontSize / FIXED_TEXT_FONT_SIZE_RATIO)
}

/**
 * font.size の下限/上限。
 * 下限 8pt 相当（読めなくならない最小）／上限はページ高依存なので呼び出し側で渡す。
 */
export const FIXED_TEXT_FONT_SIZE_MIN = 8

/**
 * font.size から bbox.h を逆算する（双方向不変条件・font→bbox 経路）。
 * `computeFixedTextFontSize` の逆。**同一定数 `FIXED_TEXT_FONT_SIZE_RATIO` を共有**し二重定義しない。
 * `bbox.h := font.size / RATIO`。
 */
export function bboxHeightFromFontSize(fontSize: number): number {
  return fontSize / FIXED_TEXT_FONT_SIZE_RATIO
}

/**
 * font.size を下限〜上限でクランプする。
 * 下限 `FIXED_TEXT_FONT_SIZE_MIN`・上限 `maxFontSize`（＝ページ高 × RATIO を呼び出し側で算出して渡す）。
 * 上限が下限未満になる異常時は下限を優先（潰さない）。
 */
export function clampFixedTextFontSize(
  fontSize: number,
  maxFontSize: number,
): number {
  const upper = Math.max(FIXED_TEXT_FONT_SIZE_MIN, maxFontSize)
  return Math.max(FIXED_TEXT_FONT_SIZE_MIN, Math.min(fontSize, upper))
}

/** 固定テキスト font の既定。NEW_FIELD_DEFAULTS.font を単一ソースとして参照（§3-2）。 */
export const DEFAULT_FIXEDTEXT_FONT: { family: string; size: number } = {
  ...NEW_FIELD_DEFAULTS.font,
}

/** index（0始まり）から合成 name `ft_N`（N は 1 始まり）を作る。 */
export function fixedTextFieldName(index: number): string {
  return `${FIXEDTEXT_NAME_PREFIX}${index + 1}`
}

/**
 * FixedText[] → EditorField[]（bbox-pane へ渡す形）＋ side table（meta）。
 *
 * - 座標は無変換（左上原点 pt のまま EditorField.bbox へ詰め替え）。
 * - name は index ベースで `ft_1, ft_2, ...` を採番（順序安定）。
 * - label には value を載せる（編集 UI で内容を判別するため・whiteout との差異）。
 * - value / font は meta(Map) に退避し、保存時に再合流する。
 */
export function fixedTextsToFields(texts: FixedText[]): {
  fields: EditorField[]
  meta: Map<string, FixedTextMeta>
} {
  const fields: EditorField[] = []
  const meta = new Map<string, FixedTextMeta>()
  texts.forEach((ft, i) => {
    const name = fixedTextFieldName(i)
    fields.push({
      name,
      label: ft.value,
      bbox: {
        x: ft.bbox.x,
        y: ft.bbox.y,
        w: ft.bbox.w,
        h: ft.bbox.h,
        page: ft.bbox.page,
      },
    })
    meta.set(name, {
      value: ft.value,
      font: { family: ft.font.family, size: ft.font.size },
    })
  })
  return { fields, meta }
}

/**
 * EditorField[]（編集結果）→ FixedText[]（保存用）。
 *
 * - 座標は無変換（EditorField.bbox → FixedText.bbox）。
 * - value は meta から復元（meta 欠落時は label を value に・安全側補完）。
 * - font.size は **bbox から案ア式で算出**して書き込む（v1.3 §3-2-6）。family は NotoSansJP 固定。
 *   meta.font.size はユーザー指定値ではなく bbox 従属の保存用値（呼び出し側も同算出で同期）。
 * - 空 value（trim 後）は固定テキストとして無意味なので除外する（§3-6）。
 */
export function fieldsToFixedTexts(
  fields: EditorField[],
  meta: Map<string, FixedTextMeta>,
): FixedText[] {
  const texts: FixedText[] = []
  for (const f of fields) {
    const m = meta.get(f.name)
    // meta 欠落（新規ドラッグ追加で meta 未登録の異常時）は label を value に、既定 font で補完。
    const value = m?.value ?? f.label ?? ''
    if (value.trim() === '') continue // 空値は保存対象外（§3-6）
    // v1.3 §3-2-6: font.size は bbox から案ア式で算出（高さ基準＋横溢れ縮小）。
    const family = m?.font.family ?? DEFAULT_FIXEDTEXT_FONT.family
    const size = computeFixedTextFontSize(f.bbox, value)
    texts.push({
      name: f.name,
      value,
      bbox: { page: f.bbox.page, x: f.bbox.x, y: f.bbox.y, w: f.bbox.w, h: f.bbox.h },
      font: { family, size },
    })
  }
  return texts
}
