import type { PdfBox } from './pdf-types'
import type { LayoutCell } from './layout-cluster'
import type { CellRole } from './whiteout-role-classifier'
import { type FieldBox, LEFT_LABEL_COL_MAX_W_RATIO } from './field-bbox-detector'
import {
  LABEL_FIELD_AREA_MAX_RATIO,
  FULLWIDTH_BAND_RATIO,
  POS_LABEL_MAX_W_RATIO,
  LABEL_COLHIST_ZERO_MAX,
} from './whiteout-constants'

/**
 * §5-2 3 重ラベル判定。OR でいずれか当たればラベルセル = 塗らない。
 *   (1) role==='label'（Claude 判定）
 *   (3) labelLexiconHit（語彙、OCR 崩れに保険）
 *   (2) 行内最左 かつ 幅 ≤ ページ幅 * LEFT_LABEL_COL_MAX_W_RATIO（位置、OCR text 非依存）
 * 背景色（薄背景ラベルセル）は一切参照しない（指示①厳守）。
 */
export function isLabelCell(
  cell: LayoutCell,
  role: CellRole | undefined,
  pageWidthPt: number,
): boolean {
  if (role === 'label') return true
  if (cell.labelLexiconHit) return true
  if (cell.isLeftmostInRow && cell.bbox.w <= pageWidthPt * LEFT_LABEL_COL_MAX_W_RATIO) {
    return true
  }
  return false
}

/** ラベルセル（中心 + セル bbox）。v0.7.3 で面積比判定のため cellBbox も保持する。 */
export interface LabelCenter {
  cx: number
  cy: number
  cellBbox: PdfBox
}

/** §3-1 課題① の判定内訳（診断ログ用）。どの理由で残ったか / 除外されたかを実値で示す。 */
export interface FieldLabelDecision {
  isLabel: boolean
  /** 内包しているラベルセル（あれば）。診断用。 */
  hit?: LabelCenter
  /** 除外/残留の判定根拠。 */
  reason: 'areaB-guard' | 'no-contain' | 'byAreaRatio' | 'byFullwidth' | 'kept-large'
  labelArea?: number
  fieldArea?: number
  ratio?: number
}

/**
 * v0.7.3 §3-1 課題①。「field がラベルを内包」→「field 自体がラベルセル（ほぼ一致）」に変更。
 *
 * ラベル除外の本来意図は「field bbox 自体がラベルセル（塗ってはいけない項目名欄）」を弾くこと。
 * 大枠（議事内容）が中の番号ラベルを内包するのは正常 → 除外しない。2 条件の AND ゲート:
 *   (A) field がラベル中心を内包する
 *   AND (B) field がそのラベルセルと「ほぼ一致」（面積比 <= LABEL_FIELD_AREA_MAX_RATIO）
 *        または 全幅 1 行薄帯（FULLWIDTH_BAND_RATIO 以上幅 × 1 行高以下）
 * エリアB（外周罫線大枠）は定義上ラベルセルになり得ないので無条件で除外対象外。
 * 背景色は一切参照しない（指示①厳守）。
 */
export function decideFieldItselfLabel(
  fb: FieldBox,
  labelCenters: LabelCenter[],
  pageWidthPt: number,
): FieldLabelDecision {
  // 大枠ガード: エリアB は無条件で「field 自体がラベル」ではない
  if (fb.area === 'B') return { isLabel: false, reason: 'areaB-guard' }

  let lastHit: LabelCenter | undefined
  let lastLabelArea = 0
  let lastFieldArea = 0
  let lastRatio = 0
  for (const lc of labelCenters) {
    // (A) field がラベル中心を内包
    const contains =
      lc.cx >= fb.bbox.x &&
      lc.cx <= fb.bbox.x + fb.bbox.w &&
      lc.cy >= fb.bbox.y &&
      lc.cy <= fb.bbox.y + fb.bbox.h
    if (!contains) continue

    const fieldArea = fb.bbox.w * fb.bbox.h
    const labelArea = Math.max(1, lc.cellBbox.w * lc.cellBbox.h)
    const ratio = fieldArea / labelArea
    lastHit = lc
    lastLabelArea = labelArea
    lastFieldArea = fieldArea
    lastRatio = ratio

    // (B) ほぼ一致（面積比）: field がラベルセルの LABEL_FIELD_AREA_MAX_RATIO 倍以内
    if (fieldArea <= labelArea * LABEL_FIELD_AREA_MAX_RATIO) {
      return {
        isLabel: true,
        hit: lc,
        reason: 'byAreaRatio',
        labelArea,
        fieldArea,
        ratio,
      }
    }

    // 補助: 全幅 1 行帯（薄いラベル帯）は面積比に関わらず除外維持
    const isFullWidthThinBand =
      fb.bbox.w >= pageWidthPt * FULLWIDTH_BAND_RATIO &&
      fb.bbox.h <= lc.cellBbox.h * 1.5
    if (isFullWidthThinBand) {
      return {
        isLabel: true,
        hit: lc,
        reason: 'byFullwidth',
        labelArea,
        fieldArea,
        ratio,
      }
    }
  }

  if (lastHit) {
    // 内包しているが面積比/全幅帯のどちらにも当たらない = 大枠として残す
    return {
      isLabel: false,
      hit: lastHit,
      reason: 'kept-large',
      labelArea: lastLabelArea,
      fieldArea: lastFieldArea,
      ratio: lastRatio,
    }
  }
  return { isLabel: false, reason: 'no-contain' }
}

export function isFieldItselfLabel(
  fb: FieldBox,
  labelCenters: LabelCenter[],
  pageWidthPt: number,
): boolean {
  return decideFieldItselfLabel(fb, labelCenters, pageWidthPt).isLabel
}

/**
 * v0.7.4 §3-1 残①。位置ベース直接ラベル除外（OCR 非依存）。
 * 罫線 field box の幾何だけで「帯内最左 AND 幅狭」をラベル列とみなす。
 *
 * cluster 経由ラベル除外（isFieldItselfLabel）は OCR が読めたラベルにしか効かない。
 * 「日時/場所/出席者」が OCR で読めず cluster にラベルセル不在のとき、罫線 field の
 * 最左狭セルが除外漏れで塗られる真因①を、この位置除外で塞ぐ。
 *
 * 背景色は一切参照せず、field box の x/w（罫線座標）のみ（指示①厳守）。
 * 誤爆しない線引き: 「最左 AND 幅狭」の AND。記入欄本体（広い or 最左でない）は除外されない。
 */
export function isPositionalLabel(
  fb: FieldBox,
  bandLeftMostX: number,
  pageWidthPt: number,
): boolean {
  const isLeftMost = Math.abs(fb.bbox.x - bandLeftMostX) < 1e-3
  const isNarrow = fb.bbox.w <= pageWidthPt * POS_LABEL_MAX_W_RATIO
  return isLeftMost && isNarrow
}

/**
 * v0.8.1 §3-P1② / v0.8.2 §3-A（難所A）。項目区画（range）ローカルの最左ラベル除外。
 *
 * 真因②（v0.8 §1）: 「氏名」ラベル(x=342)が帯内グローバル最左(x=65)でないため isPositionalLabel
 * で除外漏れ → インク（印字）を記入と拾い誤塗り。本関数は §3-P1① で横並び分割した各 range の
 * 最左狭セルをラベル候補にする（帯内グローバル最左だけでなく各項目区画ローカルの最左も対象）。
 *
 * 🚨 v0.8.2 難所A（§3-A）: 幅だけでは「場所記入左(w73 分散)」と「氏名ラベル(w39 端偏在)」を分離
 * できない（両方とも narrow）。インク列分布の **分散度** を併用して区別する:
 *   - ラベル印字 = 列分布が端に偏在（colHist のゼロ列が LABEL_COLHIST_ZERO_MAX 以上）→ 除外する
 *   - 記入文字   = 列分布が全列に分散（ゼロ列が少ない）→ 除外しない（記入欄として残す）
 *   実機 ink-dist: 氏名ラベル colHist=[0,0,0,9,32,47,44,43] ゼロ 3 列 → 除外 /
 *   場所記入左 colHist=[32,45,37,53,47,26,35,97] ゼロ 0 列 → 残す。
 *
 * 🚨 背景色非依存（§0-A 最デリケート箇所・厳命①）: 判定軸は位置（range 最左か）+ 幅（狭いか）+
 * インク列分布の分散度（colHist）のみで、地色（bgLuma）の絶対値は一切見ない。colHist は前景インク
 * 画素の列分布（地色不使用）。氏名ラベルを「グレーだから」では除外しない＝過去却下のグレー帯検出と異なる。
 *
 * @param fb              判定対象セル
 * @param rangeLeftMostX  そのセルが属する range（横並び分割後の項目区画）の最左セルの x
 * @param pageWidthPt     ページ幅 pt（幅狭判定の基準）
 * @param colHist         （任意）そのセルの前景インク 8 分割列ヒストグラム。未供給なら従来どおり
 *                        位置+幅のみで判定（後方互換）。
 */
export function isPositionalLabelInRange(
  fb: FieldBox,
  rangeLeftMostX: number,
  pageWidthPt: number,
  colHist?: number[],
): boolean {
  const isLeftMost = Math.abs(fb.bbox.x - rangeLeftMostX) < 1e-3
  const isNarrow = fb.bbox.w <= pageWidthPt * POS_LABEL_MAX_W_RATIO
  if (!isLeftMost || !isNarrow) return false
  // インク列分布が無い（colHist 未供給）なら従来どおり位置+幅で判定（後方互換）。
  if (!colHist) return true
  // §3-A 偏在度: ゼロ列数で分散/偏在を判定。記入文字は分散（ゼロ列 < LABEL_COLHIST_ZERO_MAX）。
  const zeroCols = colHist.filter(v => v === 0).length
  const isConcentrated = zeroCols >= LABEL_COLHIST_ZERO_MAX // 例 8 列中 >=3 がゼロ＝偏在＝ラベル
  return isConcentrated // 分散（記入文字）なら false＝除外しない
}
