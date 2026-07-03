/**
 * 罫線ベース青枠スナップ（グループX・設計書 g2_bbox_rule_based_design v0.3 / 方式 X1 確定）。
 *
 * AI が推測した記入欄 bbox（templates.fields.bbox）を、罫線検出セル（FieldBox）を
 * 座標源にして実際の記入欄へスナップする純関数。マッチした field は罫線セル座標へ置換し、
 * マッチ無し/罫線なしは AI bbox 維持（フォールバック・退行なし）。
 *
 * v0.3（実機FB修正）の核心:
 *   - B1 記入欄特定（identifyEntryCells）: 帯内の狭セル（ラベル）を全除外し記入欄セルだけ残す。
 *     これで小セルの左端 xL がラベル細セル込みで歪む全幅化（実機主因）を解消。右端は range.xR
 *     （＝外枠 = 検出器が出す最右）が既に正しい（X1 確定）ので右端拡張ロジックは持たない。
 *   - B2 area A/B マッチガード（matchBandForField）: aiField.h で small/大枠を判定し、small は
 *     area A 帯優先（無ければ area B 保険）、大枠は area B 優先（無ければ area A 保険）。
 *     small field が area B 大枠に誤吸着するのを防ぐ。
 *   - B3 横並び保険（assignRange）: 同一帯に range が 2 つ以上のときだけ順序ベース併用。
 *   - snap に自動中央寄せは持たない。
 *
 * 🚨 死守（白塗りN-6 無改変）:
 *   - 検出器（field-bbox-detector）の検出・判定ロジックは一切呼ばない。出力 FieldBox[] を
 *     入力に受け取るだけ。検出器ファイルは完全無改変（X1＝戻り値拡張も診断ログも無し）。
 *   - 横並び分割・帯グルーピング・記入欄特定は白塗り（whiteout-pipeline）の「発想」を
 *     参照して幾何のみで独立実装（インク判定なし＝空欄テンプレで青枠が消えない・設計 §3）。
 *   - 検出器 const（POS_LABEL_MAX_W_RATIO / INSET_*_PT / AREA_B_MIN_SIZE_PX）は import 共有。
 *     snap 専用の閾値（LABEL_REL_RATIO / SMALL_FIELD_H_PT / MIN_BAND_Y_OVERLAP）はローカル
 *     新規（検出器の判定 const ではない＝検出器無改変・白塗り無影響）。
 *
 * 座標は pt 単位・左上原点（PdfBox / BboxPt 共通）。純関数（DOM/IO 非依存・unit 対象）。
 */
import type { PageMeta, PagedBboxField, BboxPt } from './bbox-coords'
import { type FieldBox, type RasterPagePixels } from '../parsers/pdf/field-bbox-detector'
import {
  BAND_GROUP_GAP_PT,
  BAND_RANGE_SPLIT_GAP_PT,
  POS_LABEL_MAX_W_RATIO,
  INSET_LEFT_PT,
  INSET_RIGHT_PT,
  INSET_TOP_PT,
  INSET_BOTTOM_PT,
} from '../parsers/pdf/whiteout-constants'
import {
  boundingBox,
  overlap1D,
  expandRightEdgeByPixels,
  expandBottomEdgeByPixels,
  splitBandBByPixelHLines,
  probeAreaBEntryLeftByPixels,
} from './rule-based-snap-pixels'

// =============================================================================
// snap 専用ローカル const（検出器の判定 const ではない＝検出器ファイル無変更・白塗り無影響）。
// 検出器から import するのは labelMaxW 用 POS_LABEL_MAX_W_RATIO / 横並び分割 BAND_RANGE_SPLIT_GAP_PT /
// 帯化 BAND_GROUP_GAP_PT / inset INSET_*_PT（値を共有し白塗りとブレさせない）。
// =============================================================================

/**
 * B1 相対フォールバック: 記入欄(最大幅)の何割未満を細セル(ラベル)として除外するか。
 * 既定 OFF（USE_REL_LABEL_CUT=false）。別テンプレで部署/氏名等が絶対閾値で割れない時 ON にする。
 * 実機チューニング前提。
 */
const LABEL_REL_RATIO = 0.5
const USE_REL_LABEL_CUT = false

/**
 * B2 small/大枠 判定の高さ境（pt）。aiField.h がこれ以下なら small（area A 優先）、超なら大枠（area B 優先）。
 * 実値: 小セル h=16.8〜17 / 大枠 h=52〜352.9 → 中間の 40 で明確に切れる。実機微調整（P2）。
 */
const SMALL_FIELD_H_PT = 40

/**
 * B2 area A 帯を small field に採用する最小 y 重なり比（aiField 高さに対する重なり割合）。
 * これ未満しか重ならない area A 帯は採用せず area B 保険へ回す。実機微調整（P2）。
 */
const MIN_BAND_Y_OVERLAP = 0.3

// =============================================================================
// P1.6b 本丸修正の snap ローカル const（検出器無改変・白塗り無影響）。
// 実値で原因確定: 真の右外枠=553.5pt(95%)・検出器が拾う 431(74%)は大枠右辺。最下部に画素横罫線
// 741/760/780 が見えるが検出器が帯化できていない → 画素で右端拡張＋帯分割する。
// 画素直読の閾値（RIGHT_EXPAND_RUN_RATIO 等）と実行ロジックは rule-based-snap-pixels.ts に
// 分割されている。ここには本体（resolveAreaBEntryLeft / computeAreaAEntryLeft）が使う
// 左端解決系の const のみ残す。
// =============================================================================

/**
 * 左端実測採用の過剰縮小ガード（pt）。areaB 全幅1セルで左端を実測値（案⑦/⑥）へ寄せるとき、
 * 結果の記入欄幅がこれ未満になるなら採用しない（潰れ防止）。inset(両辺3pt) 後も 1pt 確保できる余裕。
 */
const AI_LEFT_MIN_W_PT = 12

/**
 * 案⑦ areaA 記入欄左端 最頻値の集計トレラント（pt）。左端 x をこの幅でビン化して最頻値を取る
 * （同一記入欄列の微小な検出ブレを 1 つに束ねる）。最頻が割れたら最小値を採るので過大採用しない。
 */
const AREAA_LEFT_BIN_PT = 4

/** snap 内訳（診断・補正UI ヒント用・設計 §2/§4）。area 種別も保持。 */
export interface SnapDiag {
  name: string
  source: 'ruled' | 'ai-fallback'
  reason: string
  /** スナップ採用した帯の area 種別（ruled 時のみ）。 */
  area?: 'A' | 'B'
}

export interface SnapResult {
  /** bbox を罫線セル座標へスナップ（記入欄を意味する）した新 field 配列（並び順は入力どおり）。 */
  fields: PagedBboxField[]
  diag: SnapDiag[]
}

/** 帯（y 近接でまとめたセル群）。 */
export interface Band {
  cells: FieldBox[]
}

/**
 * AI 生成 field（記入欄を意図した bbox）を罫線検出セルにスナップする純関数。
 *
 * @param aiFields          AI bbox を持つ field（page 付き bbox）。
 * @param ruledCellsByPage  page → 検出器セル（area A=罫線セル / B=外周大枠）。
 * @param pageMetaByPage    page → PageMeta（ラベル列除外で widthPt を使う）。
 * @returns スナップ後 fields（マッチ無しは AI 維持）＋ 各 field の diag。
 */
export function snapFieldsToRuledCells(
  aiFields: PagedBboxField[],
  ruledCellsByPage: Map<number, FieldBox[]>,
  pageMetaByPage: Map<number, PageMeta>,
  pixelsByPage?: Map<number, RasterPagePixels>,
): SnapResult {
  const diag: SnapDiag[] = []

  // 案⑦ areaA 記入欄左端の最頻値を page 単位でキャッシュ（全 field 走査で再計算しない）。
  const areaAEntryLeftByPage = new Map<number, AreaAEntryLeft>()

  const fields = aiFields.map((field) => {
    const page = field.bbox.page
    const cells = ruledCellsByPage.get(page) ?? []
    const meta = pageMetaByPage.get(page)
    const name = fieldName(field)
    const aiBox: BboxPt = field.bbox
    const px = pixelsByPage?.get(page)

    // 罫線なしテンプレ（cells 空）or page メタ欠落 → AI bbox 維持（§4 フォールバック）。
    if (cells.length === 0 || !meta) {
      diag.push({
        name,
        source: 'ai-fallback',
        reason: cells.length === 0 ? 'no-ruled-cells' : 'no-page-meta',
      })
      return field
    }

    const pageWidthPt = meta.widthPt

    // (A') area 別に帯化（B2: small は area A 優先・大枠は area B 優先でマッチさせるため）。area A は無改変。
    const bandsB = groupCellsIntoBands(cells.filter((c) => c.area === 'B'))
    // NG-A 下端拡張（案A）: 最下部帯（y 最大の area B 帯）だけ、検出器が切った下端を画素の
    //   真の下罫線まで広げてから split へ渡す（next_meeting 行を救う）。線が無ければ無拡張で
    //   元帯のまま（退行なし）。他帯は不変・1range 従来パスにも触れない。
    const bandsBExpanded = px ? expandBottomBandOfBandsB(bandsB, px, page) : bandsB
    // NG2/3: area B 帯は画素横罫線で子帯に分割（検出器が帯化漏れした最下部 decisions/attachments/
    //   next_meeting を 741/760/780 で割る）。横罫線が無ければ分割しない（退行なし）。
    const bandsBSplit = px
      ? bandsBExpanded.flatMap((band) => splitBandBByPixelHLines(band, px))
      : bandsBExpanded
    const bandsByArea = {
      A: groupCellsIntoBands(cells.filter((c) => c.area === 'A')),
      B: bandsBSplit,
    }

    // (B) area A/B マッチガード（B2: h 主判定＋area 優先保険）。B2 ロジックは無改変＝帯入力が改善されるだけ。
    const matched = matchBandForField(aiBox, bandsByArea)

    if (!matched) {
      diag.push({ name, source: 'ai-fallback', reason: 'no-band' })
      return field
    }

    // (C) 記入欄特定（B1: 狭セル＝ラベルを全除外し記入欄セルだけ残す。左端 xL の歪み解消）。
    const entryCells = identifyEntryCells(matched.band.cells, pageWidthPt)
    if (entryCells.length === 0) {
      diag.push({ name, source: 'ai-fallback', reason: 'no-entry-cells' })
      return field
    }

    // (D) 横並び分割（x 昇順・隣接 gap > BAND_RANGE_SPLIT_GAP_PT で別 range・インク非依存）。
    const ranges = splitByHorizontalGap(entryCells, BAND_RANGE_SPLIT_GAP_PT)

    // (E) range 選択（B3: 2range 以上のときだけ順序ベース併用・1range は従来パス）。
    const range = assignRange(ranges, aiBox)
    if (!range || range.length === 0) {
      diag.push({ name, source: 'ai-fallback', reason: 'no-range' })
      return field
    }

    // (F) スナップ座標 = range の外接矩形。
    //     area B 大枠も帯セルの実 y/h を採用（過大 h 解消）。
    const bounded = boundingBox(range)
    // (F-2) NG1 右端拡張: 検出器が拾う右端（431=大枠右辺・74%）の右に真の外周罫線（553.5=95%）が
    //   あるケースを画素で実測して右端だけ拡張する。見つからねば bounded のまま（退行なし）。
    const expanded = px
      ? expandRightEdgeByPixels(bounded, px)
      : bounded
    // (F-3) 左端被り再修正（案⑦主＋案⑥保険）: areaB 全幅1セル（ラベル|記入欄の内部縦罫線なし）は
    //   左端がラベルまで全幅化して被る。右端 y/h は罫線で正しいので維持し、左端だけ実測値へ寄せる。
    //   案⑤(AI採用)は寄せすぎ実機NGで廃止 → AI 非依存・areaA 記入欄左端の最頻値（案⑦）／無ければ
    //   画素プローブ（案⑥）。どちらも不可なら expanded 不変（退行ゼロ）。条件①②③は維持。
    let aaLeft = areaAEntryLeftByPage.get(page)
    if (!aaLeft) {
      aaLeft = computeAreaAEntryLeft(bandsByArea.A, pageWidthPt)
      areaAEntryLeftByPage.set(page, aaLeft)
    }
    const leftAdjusted = resolveAreaBEntryLeft(expanded, range, matched.area, aaLeft, px).box

    // (G) inset（罫線内側へ・検出器 const と同値）。右端拡張＋左端実測採用後の矩形に適用する。
    const snappedBox = insetBox(leftAdjusted, pageWidthPt, meta.heightPt)

    diag.push({ name, source: 'ruled', reason: 'snapped', area: matched.area })
    return {
      ...field,
      bbox: { ...snappedBox, page },
    }
  })

  return { fields, diag }
}

// =============================================================================
// 内部ヘルパ（すべて純幾何・インク非依存）
// =============================================================================

function fieldName(field: PagedBboxField): string {
  const n = (field as { name?: unknown }).name
  return typeof n === 'string' ? n : ''
}

/**
 * (A) 帯グルーピング。セルを y(top) 昇順に並べ、隣接セルの top が BAND_GROUP_GAP_PT 以内なら
 * 同一帯にまとめる（白塗り groupAreaACellsIntoBands の y 近接発想・インク非依存で再実装）。
 */
export function groupCellsIntoBands(cells: FieldBox[]): Band[] {
  if (cells.length === 0) return []
  const sorted = [...cells].sort((a, b) => a.bbox.y - b.bbox.y)
  const bands: Band[] = []
  let current: FieldBox[] = [sorted[0]]
  let bandTop = sorted[0].bbox.y
  for (let i = 1; i < sorted.length; i++) {
    const c = sorted[i]
    if (c.bbox.y - bandTop <= BAND_GROUP_GAP_PT) {
      current.push(c)
    } else {
      bands.push({ cells: current })
      current = [c]
      bandTop = c.bbox.y
    }
  }
  bands.push({ cells: current })
  return bands
}

/** (B) aiBox と y レンジが最も重なる帯を返す（重なりゼロなら null）。 */
function bandWithMaxYOverlap(bands: Band[], aiBox: BboxPt): Band | null {
  let best: Band | null = null
  let bestOverlap = 0
  for (const band of bands) {
    const ov = overlap1D(aiBox.y, aiBox.y + aiBox.h, bandYTop(band), bandYBottom(band))
    if (ov > bestOverlap) {
      bestOverlap = ov
      best = band
    }
  }
  return best
}

/** 帯の y 上端（帯内セルの min top）。 */
function bandYTop(band: Band): number {
  return Math.min(...band.cells.map((c) => c.bbox.y))
}

/** 帯の y 下端（帯内セルの max bottom）。 */
function bandYBottom(band: Band): number {
  return Math.max(...band.cells.map((c) => c.bbox.y + c.bbox.h))
}

/**
 * (NG-A) 最下部帯のインデックス（y 下端 = max bottom が最大の帯）。空配列/空帯は -1。
 * 下端拡張を「最下部帯だけ」に限定するためのガード（他帯・1range 従来パスに触れない）。
 */
export function lowestBandIndex(bands: Band[]): number {
  let idx = -1
  let bestBot = -Infinity
  for (let i = 0; i < bands.length; i++) {
    if (bands[i].cells.length === 0) continue
    const bot = bandYBottom(bands[i])
    if (bot > bestBot) {
      bestBot = bot
      idx = i
    }
  }
  return idx
}

/**
 * (NG-A 案A) area B 帯群のうち最下部帯だけ、検出器が切った下端を画素の真の下罫線まで拡張する。
 * 拡張ありなら最下部帯を「拡張後 outer を持つ 1 セル帯（x 範囲は親継承・area='B'）」へ置換、
 * 線が無ければ全帯そのまま（退行なし）。他帯は不変＝1range 従来パスにも触れない。
 *
 * 注（横並び複数セル帯）: 最下部帯が横並び複数セル（部署｜氏名 等）だった場合、boundingBox で
 * 外接 1 セルに潰してから拡張するため横分割情報は失われる。今回対象（最下部 = 添付/次回予定の
 * 全幅単一大枠）では横並びが無く実害なし。横並び最下部帯が出る様式が将来現れたら要再設計。
 */
export function expandBottomBandOfBandsB(
  bandsB: Band[],
  px: RasterPagePixels,
  page: number,
): Band[] {
  const idx = lowestBandIndex(bandsB)
  if (idx < 0) return bandsB

  const outer = boundingBox(bandsB[idx].cells)
  const beforeBot = outer.y + outer.h
  const expanded = expandBottomEdgeByPixels(outer, px)
  const grew = expanded.y + expanded.h > beforeBot + 1e-6
  if (!grew) return bandsB

  return bandsB.map((band, i) =>
    i === idx ? { cells: [{ page, area: 'B' as const, bbox: expanded }] } : band,
  )
}

/**
 * (B2) area A/B マッチガード（設計 §B2）。aiField.h で small/大枠を判定し、
 * small（h ≤ SMALL_FIELD_H_PT）は area A 帯を優先（y 重なり比が MIN_BAND_Y_OVERLAP 以上）、
 * 無ければ area B 保険。大枠は area B 優先、無ければ area A 保険。
 * これで small field（添付等）が area B 大枠（決定事項等）へ誤吸着するのを防ぐ。
 */
export function matchBandForField(
  aiBox: BboxPt,
  bandsByArea: { A: Band[]; B: Band[] },
): { band: Band; area: 'A' | 'B' } | null {
  const isSmall = aiBox.h <= SMALL_FIELD_H_PT
  const aiH = Math.max(1e-6, aiBox.h)

  if (isSmall) {
    // small → area A 優先（y 重なり比ガード付き）。無ければ area B 保険。
    const bandA = bandWithMaxYOverlap(bandsByArea.A, aiBox)
    if (bandA) {
      const ratio =
        overlap1D(aiBox.y, aiBox.y + aiBox.h, bandYTop(bandA), bandYBottom(bandA)) / aiH
      if (ratio >= MIN_BAND_Y_OVERLAP) return { band: bandA, area: 'A' }
    }
    const bandB = bandWithMaxYOverlap(bandsByArea.B, aiBox)
    return bandB ? { band: bandB, area: 'B' } : null
  }

  // 大枠 → area B 優先。無ければ area A 保険。
  const bandB = bandWithMaxYOverlap(bandsByArea.B, aiBox)
  if (bandB) return { band: bandB, area: 'B' }
  const bandA = bandWithMaxYOverlap(bandsByArea.A, aiBox)
  return bandA ? { band: bandA, area: 'A' } : null
}

/**
 * (C / B1) 記入欄特定。帯内の狭セル（ラベル）を全除外し記入欄セルだけ残す（設計 §B1）。
 *   - 絶対閾値: w > pageWidth × POS_LABEL_MAX_W_RATIO（検出器 const・既存同値）。
 *   - 相対閾値（既定 OFF）: USE_REL_LABEL_CUT 時のみ w >= maxW × LABEL_REL_RATIO も AND。
 *   - 全滅ガード: 候補が空なら帯内最大幅セルを 1 つだけ記入欄として残す（誤全除外しない安全側）。
 *   - cells が 1 セル以下はそのまま（除外しない）。
 *
 * これで実機の全幅化（ラベル細セル込みで左端 xL が歪む）を解消する。
 */
export function identifyEntryCells(cells: FieldBox[], pageWidthPt: number): FieldBox[] {
  if (cells.length <= 1) return [...cells]
  const labelMaxW = pageWidthPt * POS_LABEL_MAX_W_RATIO
  const maxW = Math.max(...cells.map((c) => c.bbox.w))

  const entry = cells.filter(
    (c) =>
      c.bbox.w > labelMaxW &&
      (!USE_REL_LABEL_CUT || c.bbox.w >= maxW * LABEL_REL_RATIO),
  )

  if (entry.length === 0) {
    // 全滅ガード: 最大幅セル 1 つを記入欄として残す（記入欄が全部狭い様式の保険）。
    const widest = cells.find((c) => c.bbox.w === maxW)
    return widest ? [widest] : []
  }
  return entry
}

/**
 * (D) 横並び分割。セルを x 昇順に並べ、隣接セル間の水平 gap が splitGapPt を超えたら
 * 別 range（横並び項目の境界）に割る（白塗り mergeInkCellsInBand の BAND_RANGE_SPLIT_GAP 発想・
 * ただしインク判定を外し全セルを対象）。部署｜氏名 を 1 枠に繋がない。
 *
 * @returns range の配列（各 range は x 連続するセル群）。
 */
export function splitByHorizontalGap(cells: FieldBox[], splitGapPt: number): FieldBox[][] {
  if (cells.length === 0) return []
  const sorted = [...cells].sort((a, b) => a.bbox.x - b.bbox.x)
  const ranges: FieldBox[][] = []
  let current: FieldBox[] = [sorted[0]]
  let prevRight = sorted[0].bbox.x + sorted[0].bbox.w
  for (let i = 1; i < sorted.length; i++) {
    const c = sorted[i]
    const gap = c.bbox.x - prevRight
    if (gap > splitGapPt) {
      ranges.push(current)
      current = [c]
    } else {
      current.push(c)
    }
    prevRight = Math.max(prevRight, c.bbox.x + c.bbox.w)
  }
  ranges.push(current)
  return ranges
}

/** (E) aiBox と最も x 重なりの大きい range を返す（重なりゼロなら null）。 */
function rangeWithMaxXOverlap(ranges: FieldBox[][], aiBox: BboxPt): FieldBox[] | null {
  let best: FieldBox[] | null = null
  let bestOverlap = 0
  for (const range of ranges) {
    const b = boundingBox(range)
    const ov = overlap1D(aiBox.x, aiBox.x + aiBox.w, b.x, b.x + b.w)
    if (ov > bestOverlap) {
      bestOverlap = ov
      best = range
    }
  }
  return best
}

/**
 * (E / B3) range 選択。1 range なら従来どおりそれを返す（挙動不変）。
 * 2 range 以上のときだけ、まず x 重なり最大（rangeWithMaxXOverlap）で選ぶ。
 *
 * 注（B3 順序ベース併用）: 設計 §B3 の順序ベース併用は「同一帯に複数 aiField が来る」
 * ケースの保険だが、本関数は 1 field 単位で呼ばれる（snap は field ごとに帯マッチするため
 * 同帯内の他 field を持たない）。よって x 重なり最大での選択を採用し、重なりゼロのときは
 * フォールバック（null→AI 維持）。複数 aiField を 1 帯へ割り当てる順序ベースは、将来 2range
 * テンプレが顕在化したとき呼び出し側で導入する余地を残す（今回テンプレは 1range で挙動不変）。
 */
function assignRange(ranges: FieldBox[][], aiBox: BboxPt): FieldBox[] | null {
  if (ranges.length === 0) return null
  if (ranges.length === 1) return ranges[0]
  return rangeWithMaxXOverlap(ranges, aiBox)
}

/** 案⑦ areaA 記入欄左端の集計結果（lefts=全 areaA 記入欄左端 x 一覧・mode=最頻値 or null）。 */
export interface AreaAEntryLeft {
  lefts: number[]
  mode: number | null
}

/**
 * 案⑦ 集計。同ページの areaA 帯から identifyEntryCells で記入欄セルを取り、その左端 x を全収集して
 * 最頻値（AREAA_LEFT_BIN_PT でビン化）を出す（最頻が割れたらビンの最小値＝過大採用しない）。
 * 検出器の確実な実測値なのでチューニング不要。記入欄セルが無ければ mode=null（案⑥保険へ回す）。
 */
export function computeAreaAEntryLeft(bandsA: Band[], pageWidthPt: number): AreaAEntryLeft {
  const lefts: number[] = []
  for (const band of bandsA) {
    for (const cell of identifyEntryCells(band.cells, pageWidthPt)) {
      lefts.push(cell.bbox.x)
    }
  }
  if (lefts.length === 0) return { lefts, mode: null }

  // AREAA_LEFT_BIN_PT 幅でビン化し最頻ビンを取る。同数なら左端最小のビンを採る（過大採用回避）。
  const binCount = new Map<number, { count: number; minX: number }>()
  for (const x of lefts) {
    const bin = Math.round(x / AREAA_LEFT_BIN_PT)
    const cur = binCount.get(bin)
    if (cur) {
      cur.count++
      cur.minX = Math.min(cur.minX, x)
    } else {
      binCount.set(bin, { count: 1, minX: x })
    }
  }
  let best: { count: number; minX: number } | null = null
  for (const v of binCount.values()) {
    if (!best || v.count > best.count || (v.count === best.count && v.minX < best.minX)) {
      best = v
    }
  }
  return { lefts, mode: best ? best.minX : null }
}

/** 左端解決の出所（診断ログ (8) 用）。 */
export type LeftSource = 'areaA-borrow' | 'pixel-probe' | 'fallback-kept'

/**
 * (F-3) 左端被り再修正（案⑦主＋案⑥保険）。areaB 全幅1セル（ラベル|記入欄の内部縦罫線が無く
 * 左端がラベルまで全幅化して被るケース）でだけ、右端・y・h は罫線由来の `expanded` を維持し、
 * 左端だけ実測値へ寄せる純関数（areaA borrow は画素非依存・$0／pixel-probe も既存 px 直読・$0）。
 *
 * 適用条件①②③（案⑤から維持・ALL 満たす時だけ発火）:
 *   1. matchedArea === 'B'（areaA＝location 等は従来どおり罫線左端）。
 *   2. range.length === 1（横分割なしの全幅1セルのみ）。
 *   3. 全幅判定: その1セル左端 ≒ 帯左端（range 外接左端・誤差 1pt）。
 * 左端の解決（優先順）:
 *   案⑦（主）: areaAEntry.mode（同ページ areaA 記入欄左端 最頻値・実測値）。
 *   案⑥（保険・areaA 不在ページのみ）: 画素プローブで外枠を弾きラベル右端＝記入欄左端を実測。
 *   どちらも不可: expanded 不変（フォールバック・全幅のまま＝退行ゼロ）。
 * 共通ガード（案⑤から維持）: 縮小方向のみ（候補x > expanded.x）・最小幅（右端-候補x >= AI_LEFT_MIN_W_PT）。
 * 右端固定・左端だけ右へ（その後 insetBox が両辺 3pt 内側へ＝既存どおり）。
 */
export function resolveAreaBEntryLeft(
  expanded: BboxPt,
  range: FieldBox[],
  matchedArea: 'A' | 'B',
  areaAEntry: AreaAEntryLeft,
  px?: RasterPagePixels,
): { box: BboxPt; source: LeftSource } {
  // 1〜3: 案⑤と同じ発火ガード。1つでも外れたら expanded 不変。
  if (matchedArea !== 'B') return { box: expanded, source: 'fallback-kept' }
  if (range.length !== 1) return { box: expanded, source: 'fallback-kept' }
  const rangeBox = boundingBox(range)
  if (Math.abs(range[0].bbox.x - rangeBox.x) > 1) return { box: expanded, source: 'fallback-kept' }

  // 案⑦（主）→ 案⑥（保険）の順で候補 x を解決。
  let candidateX: number | null = null
  let source: LeftSource = 'fallback-kept'
  if (areaAEntry.mode !== null) {
    candidateX = areaAEntry.mode
    source = 'areaA-borrow'
  } else if (px) {
    const probed = probeAreaBEntryLeftByPixels(expanded, px)
    if (probed !== null) {
      candidateX = probed
      source = 'pixel-probe'
    }
  }
  if (candidateX === null) return { box: expanded, source: 'fallback-kept' }

  const rightPt = expanded.x + expanded.w
  // 縮小方向のみ（候補が罫線左端より右）。同値/左は維持＝はみ出し防止。
  if (!(candidateX > expanded.x)) return { box: expanded, source: 'fallback-kept' }
  // 過剰縮小ガード（最小幅確保）。
  if (candidateX >= rightPt - AI_LEFT_MIN_W_PT) return { box: expanded, source: 'fallback-kept' }

  return { box: { ...expanded, x: candidateX, w: rightPt - candidateX }, source }
}

/**
 * (G) inset。罫線の内側へ各辺を検出器 const 分だけ縮める（白塗り基準 3pt と同値）。
 * w/h は最小 1pt を確保（潰れ防止）。ページ範囲は呼出側 bbox 範囲チェックに委ねるが、
 * 念のため 0 未満・page 超過にならないようクランプする。
 */
export function insetBox(b: BboxPt, pageWidthPt: number, pageHeightPt: number): BboxPt {
  let x = b.x + INSET_LEFT_PT
  let y = b.y + INSET_TOP_PT
  let w = b.w - INSET_LEFT_PT - INSET_RIGHT_PT
  let h = b.h - INSET_TOP_PT - INSET_BOTTOM_PT
  // 潰れ防止（inset が幅/高を超えたら最小 1pt）。
  if (w < 1) {
    x = b.x + b.w / 2 - 0.5
    w = 1
  }
  if (h < 1) {
    y = b.y + b.h / 2 - 0.5
    h = 1
  }
  // ページ範囲クランプ（負・超過防止）。
  x = Math.max(0, Math.min(x, pageWidthPt - w))
  y = Math.max(0, Math.min(y, pageHeightPt - h))
  return { x, y, w, h }
}

