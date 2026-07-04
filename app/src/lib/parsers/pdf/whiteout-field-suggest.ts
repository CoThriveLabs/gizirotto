import type { PdfBox } from './pdf-types'
import type { ScanOcrResult } from './scan-extractor'
import type { LayoutCluster } from './layout-cluster'
import type { CellClassification } from './whiteout-role-classifier'
import {
  type FieldBox,
  type RasterPagePixels,
  LEFT_LABEL_COL_MAX_W_RATIO,
} from './field-bbox-detector'
import {
  INSET_LEFT_PT,
  INSET_RIGHT_PT,
  INSET_TOP_PT,
  INSET_BOTTOM_PT,
  LINE_OVERLAP_FIX_PX,
} from './whiteout-constants'
import { type WhiteoutBox, DEFAULT_BG_COLOR_WHITE } from './whiteout-types'
import { isLabelCell, decideFieldItselfLabel, isFieldItselfLabel, isPositionalLabel } from './whiteout-label-classifier'
import type { LabelCenter } from './whiteout-label-classifier'
import { mergeInkCellsInBand, groupAreaACellsIntoBands } from './whiteout-band-merge'
import { fieldHasInk } from './whiteout-ink-detector'
import { logExcludeLabel, logInkCell, WHITEOUT_DIAG, fmtBox } from './whiteout-diag'

/** suggestWhiteoutCandidatesByField の診断カウンタ（route の diag log 用）。 */
export interface FieldSuggestDiag {
  areaA: number
  areaB: number
  labelExcluded: number
  /** v0.7.4 §8: 位置ベース直接ラベル除外（OCR 非依存）で落ちた数。cluster 除外と分ける。 */
  posLabelExcluded: number
  /** v0.8 §8: インク無し（前景ピクセル不足）で塗らなかったセル/大枠の数（旧 writtenFiltered）。 */
  inkFiltered: number
  /** v0.7.3 §8 / v0.8: 束ね（mergeInkCellsInBand）で生成された枠数。 */
  merged: number
  painted: number
}

/**
 * inset。矩形を内側に縮める → 外周・セル境界の罫線を残す。
 * 全辺を独立 const にして調整可能（左右同値 / 上下同値の運用）。エリアA/B 共通通過。
 * 過小側に倒れるよう w/h は 0 下限でクランプする（clamped=true を診断に出す）。
 */
function insetBox(b: PdfBox): { bbox: PdfBox; clamped: boolean } {
  const w = b.w - INSET_LEFT_PT - INSET_RIGHT_PT
  const h = b.h - INSET_TOP_PT - INSET_BOTTOM_PT
  return {
    bbox: {
      x: b.x + INSET_LEFT_PT,
      y: b.y + INSET_TOP_PT,
      w: Math.max(0, w),
      h: Math.max(0, h),
    },
    clamped: w <= 0 || h <= 0,
  }
}

/**
 * 罫線検出で得た field_bbox（エリアA セル + エリアB 大枠）を白塗り対象 WhiteoutBox[] に変換する。
 * 方針:
 *   ① 背景色を一切参照しない。判定は罫線 + written_bbox + role のみ。
 *   ② inset で外周・セル境界の罫線を残す（塗り過小側）。
 *   ③ 記入有無フィルタ: written_bbox がある欄だけ塗り、空欄は塗らない。
 *
 * 判定順（§3-3）:
 *   (1) 3 重ラベル判定（§5-2）→ ラベルなら記入有無に関わらず塗らない（ラベルは残す）
 *   (2) 記入有無フィルタ（§3-2）→ written_bbox が無ければ塗らない（空欄は元から空白）
 *   (3) inset 塗り（§5-1）→ 記入ありなら罫線内側まで枠いっぱい塗る
 *
 * role / cluster は補助（§5-3）。role 失敗（classifications=[]）でも位置 + 語彙でラベル除外、
 * エリアB は外周罫線 + インクで成立するため role 非依存（§5-3）。
 *
 * v0.8 §4 差分: 記入有無を OCR written → セル内インク（前景ピクセル）有無に差し替え（真因＝OCR漏れ）。
 *   塗り判定に ocr は使わない（pixels のインク判定が主役）。ocr はラベル判定用の pageWidthPt 源
 *   としてのみ残置（OCR 呼び出し自体は §6 で温存）。pixels が無い場合は後方互換で塗らない。
 *
 * v0.8.2 差分（設計書 n6_layout_structure_draft_v0.8.2・全て背景色非依存 §0-A）:
 *   ① 横並び分割閾値 BAND_RANGE_SPLIT_GAP_PT 40→28（部署|氏名32 は割り氏名内22 は割らない・const 変更）。
 *   ② 難所A（§3-A）: isPositionalLabelInRange に colHist 分散度を併用（場所記入左[分散]は残し氏名ラベル
 *      [端偏在]は除外）。③-B-1（§3-B-1）: hasInkInCell が端列縦フルランを罫線として控除→実効 ink で density
 *      判定 ＋ maxComponent >= INK_MIN_COMPONENT を AND（部署空欄の左右縦罫線が落ち・散在ノイズも落ちる）。
 *   ③-B-2 ink-name 追加診断（観測専用・判定不変）: 氏名記入が拾えない原因（検出 bbox ズレ / 実質空欄 /
 *      薄字）の切り分けデータを出す。氏名対策は次サイクル（実機 ink-name 実値で方針確定）。
 *   🚨 ②③とも前景幾何（colHist / 端列縦ラン / maxComponent）のみ・地色不使用。bgLuma は診断表示のみ判定不使用。
 *
 * applyWhiteout / suggestWhiteoutCandidatesByRole は無改変（並置、§12）。
 *
 * @param fieldBoxes      detectFieldBboxes の出力（エリアA/B、pt・左上原点）
 * @param cluster         buildLayoutCluster の出力（cell bbox 源、3 重ラベル判定用）
 * @param classifications classifyCellRoles の出力（cellId → role、補助）
 * @param ocr             ScanOcrResult（v0.8: pageWidthPt 源としてのみ。塗り判定には不使用）
 * @param diag            （任意）診断カウンタを書き戻す out 参照
 * @param pixelsByPage    v0.8: ページ別の共有ラスタ画素（インク判定用・再デコード回避）
 * @returns               ラベル除外 + インク有無フィルタ通過後の inset 済 WhiteoutBox[]
 */
export function suggestWhiteoutCandidatesByField(
  fieldBoxes: FieldBox[],
  cluster: LayoutCluster,
  classifications: CellClassification[],
  ocr?: ScanOcrResult,
  diag?: FieldSuggestDiag,
  pixelsByPage?: RasterPagePixels[],
): WhiteoutBox[] {
  const roleByCellId = new Map(classifications.map(c => [c.cellId, c.role]))

  // v0.8: ページ別の共有ラスタ画素（インク判定用）。page 番号で引けるよう Map 化。
  const pixelsByPageNo = new Map<number, RasterPagePixels>()
  if (pixelsByPage) {
    for (const px of pixelsByPage) pixelsByPageNo.set(px.page, px)
  }

  // ページごとの「ラベルセル中心」を 3 重判定で収集（背景色不使用）。
  // ページ幅 pt は ocr.pages[].pageSize から取得。OCR 無指定でも pixels の pageWidthPt で補完
  // （v0.8: 塗り判定は OCR 非依存だが、位置ラベル判定にページ幅が要るため pixels からも引く）。
  const pageWidthPtByPage = new Map<number, number>()
  if (ocr) {
    for (const p of ocr.pages) {
      pageWidthPtByPage.set(p.pageIndex + 1, p.pageSize.widthPt)
    }
  }
  for (const px of pixelsByPageNo.values()) {
    if (!pageWidthPtByPage.has(px.page)) pageWidthPtByPage.set(px.page, px.pageWidthPt)
  }
  // v0.7.3 §3-1: ラベルセル中心 + cellBbox を保持（面積比「ほぼ一致」判定に bbox が必要）。
  const labelCentersByPage = new Map<number, LabelCenter[]>()
  for (const page of cluster.pages) {
    for (const cell of page.cells) {
      const role = roleByCellId.get(cell.cellId)
      const pageWidthPt = pageWidthPtByPage.get(cell.page) ?? Number.POSITIVE_INFINITY
      if (isLabelCell(cell, role, pageWidthPt)) {
        const arr = labelCentersByPage.get(cell.page) ?? []
        arr.push({
          cx: cell.bbox.x + cell.bbox.w / 2,
          cy: cell.bbox.y + cell.bbox.h / 2,
          cellBbox: { ...cell.bbox },
        })
        labelCentersByPage.set(cell.page, arr)
        // [whiteout-diag] 依頼2: このラベルセルが「位置」で当たったか「語彙」で当たったか「role」かを内訳表示。
        if (WHITEOUT_DIAG) {
          const byRole = role === 'label'
          const byLex = cell.labelLexiconHit
          const byPos =
            cell.isLeftmostInRow && cell.bbox.w <= pageWidthPt * LEFT_LABEL_COL_MAX_W_RATIO
          console.log(
            `[whiteout-diag][label] p${cell.page} ${cell.cellId} ${fmtBox(cell.bbox)} ` +
              `hit=${byRole ? 'ROLE' : ''}${byLex ? 'LEX' : ''}${byPos ? 'POS' : ''} ` +
              `leftmost=${cell.isLeftmostInRow} wRatio=${(cell.bbox.w / pageWidthPt).toFixed(3)}(thr=${LEFT_LABEL_COL_MAX_W_RATIO}) ` +
              `text="${cell.text.slice(0, 12)}"`,
          )
        }
      }
    }
  }
  if (WHITEOUT_DIAG) {
    const totalCells = cluster.pages.reduce((n, p) => n + p.cells.length, 0)
    const totalLabels = [...labelCentersByPage.values()].reduce((n, a) => n + a.length, 0)
    console.log(
      `[whiteout-diag][label] summary clusterCells=${totalCells} labelCells=${totalLabels} pageWidthPt=${[...pageWidthPtByPage.values()].map(v => v.toFixed(0)).join(',')}`,
    )
  }

  let areaA = 0
  let areaB = 0
  let labelExcluded = 0
  let posLabelExcluded = 0
  let inkFiltered = 0

  // [whiteout-diag-timing] v0.8: インク判定（候補セル × セル面積走査 = O(セル面積総和)）の所要 ms。
  const tSuggest = Date.now()

  // v0.8 §4: ページごとに field を分け、エリアA は帯グルーピング + インクレンジ束ね、エリアB は
  // field 単位でインク判定。検出側 area で A/B を振り分ける（背景色非依存・インクは局所相対）。
  const pages = new Set<number>(fieldBoxes.map(fb => fb.page))
  const boxes: WhiteoutBox[] = []
  let merged = 0

  // v0.8.1 §3-P2/P3: 罫線被り補正（inset とは別レイヤ）。検出 field bbox の辺が罫線際にあるとき、
  // 塗り矩形の該当辺を罫線内側へ LINE_OVERLAP_FIX_PX だけクランプする。inset の一律内側量（P5 で 3px）を
  // 増やさずに被り辺だけ追加で内側へ寄せ、罫線保持を両立する（§3-P5 切り分け）。
  // 🚨 背景色非依存（§0-A）: クランプは field/罫線座標の幾何のみで、地色は一切見ない。
  const applyLineFix = (
    raw: PdfBox,
    fix: { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean },
  ): PdfBox => {
    let { x, y, w, h } = raw
    if (fix.left) { x += LINE_OVERLAP_FIX_PX; w -= LINE_OVERLAP_FIX_PX } // 左罫線被り → 左端を内側へ
    if (fix.right) { w -= LINE_OVERLAP_FIX_PX } // 右罫線被り → 右端を内側へ
    if (fix.top) { y += LINE_OVERLAP_FIX_PX; h -= LINE_OVERLAP_FIX_PX } // 上罫線被り → 上端を内側へ
    if (fix.bottom) { h -= LINE_OVERLAP_FIX_PX } // 下罫線被り → 下端を内側へ
    return { x, y, w: Math.max(0, w), h: Math.max(0, h) }
  }

  // inset 後に幅/高が 0 へ潰れた矩形は描画上無意味なので push しない（全辺 inset が
  // 極細セル幅/高を超えるケースの安全弁。塗り過小側に倒す方針と整合・v0.7.3 継承）。
  // lineFix: §3-P2/P3 罫線被り補正辺（指定辺を inset 前に罫線内側へクランプ）。
  const pushInsetBox = (
    page: number,
    raw: PdfBox,
    lineFix?: { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean },
  ): void => {
    // §3-P2/P3: inset の前段で被り辺を罫線内側へクランプ（inset とは別レイヤ）。
    const fixed = lineFix ? applyLineFix(raw, lineFix) : raw
    const lineFixed = lineFix
      ? !!(lineFix.left || lineFix.right || lineFix.top || lineFix.bottom)
      : false
    const { bbox, clamped } = insetBox(fixed)
    // [whiteout-diag][inset] 残③/§3-P2/P3: 罫線被り補正後 + 全辺 inset 後の座標と潰れ(clamped)有無。
    if (WHITEOUT_DIAG) {
      console.log(
        `[whiteout-diag][inset] p${page} field(${fmtBox(raw)}) ` +
          `lineFix=${lineFixed ? fmtBox(fixed) : 'none'} → inset{${fmtBox(bbox)}} clamped=${clamped}`,
      )
    }
    if (clamped) return
    boxes.push({
      page,
      bbox,
      estimatedBgColor: DEFAULT_BG_COLOR_WHITE,
      source: 'auto_suggestion',
    })
  }

  for (const pageNo of pages) {
    const pageFields = fieldBoxes.filter(fb => fb.page === pageNo)
    const labelCenters = labelCentersByPage.get(pageNo) ?? []
    const pageWidthPt = pageWidthPtByPage.get(pageNo) ?? Number.POSITIVE_INFINITY
    const pixels = pixelsByPageNo.get(pageNo)

    const areaAFields = pageFields.filter(fb => fb.area === 'A')
    const areaBFields = pageFields.filter(fb => fb.area === 'B')
    areaA += areaAFields.length
    areaB += areaBFields.length

    // --- エリアB 大枠: 束ね対象外。field 単位で label 解除（§5）+ インク判定（§2-2）。 ---
    for (const fb of areaBFields) {
      const decision = decideFieldItselfLabel(fb, labelCenters, pageWidthPt)
      if (decision.isLabel) {
        labelExcluded++
        if (WHITEOUT_DIAG) logExcludeLabel(fb, decision)
        continue
      }
      // v0.8: pixels があればインク有無で記入判定（OCR非依存）。pixels 無指定（後方互換）は塗らない。
      if (pixels) {
        const ink = fieldHasInk(fb.bbox, pixels)
        if (WHITEOUT_DIAG) logInkCell(fb, ink, false)
        if (!ink.hasInk) {
          inkFiltered++
          continue
        }
      } else {
        // 後方互換（画素なし）: 記入有無を判定できないので塗らない（空欄保護側に倒す）。
        inkFiltered++
        continue
      }
      // v0.8.1 §3-P3: 議事内容大枠の下端が罫線際 → 下辺を罫線内側へクランプ（大枠下罫線被り）。
      pushInsetBox(fb.page, fb.bbox, { bottom: true })
    }

    // --- エリアA 細セル: 帯グルーピング → 帯内でラベル(cluster/位置)除外 + インクレンジ束ね。 ---
    const bands = groupAreaACellsIntoBands(areaAFields)
    for (const band of bands) {
      // 残①: 帯内最左 x（pixels 無指定時の後方互換ラベル除外の基準）。
      const bandLeftMostX =
        band.length > 0 ? Math.min(...band.map(c => c.bbox.x)) : 0

      // pixels 未指定（後方互換）: インク判定不能。ラベル(cluster/位置)以外を個別 inset 塗り（v0.7 互換挙動）。
      // この経路では横並び分割（インク基準）は走らないため、帯内グローバル最左ラベルのみ除外する。
      if (!pixels) {
        for (const cell of band) {
          if (isFieldItselfLabel(cell, labelCenters, pageWidthPt)) {
            labelExcluded++
            continue
          }
          if (isPositionalLabel(cell, bandLeftMostX, pageWidthPt)) {
            posLabelExcluded++
            continue
          }
          pushInsetBox(cell.page, cell.bbox)
        }
        continue
      }

      // v0.8 §4 / v0.8.1 §3-P1①②: インクありセルの横並び分割 + range 最左ラベル除外 + レンジ束ね。
      // ラベル除外/インク無しのカウントは mergeInkCellsInBand 内で帯単位に集計し summary で受ける
      // （range 重複の二重計上を避けるため呼び出し側での事前カウントは廃止）。
      const { merges: mergedBoxes, summary } = mergeInkCellsInBand(
        band,
        pixels,
        labelCenters,
        pageWidthPt,
      )
      labelExcluded += summary.labelCut
      posLabelExcluded += summary.posLabelCut
      inkFiltered += summary.inkFiltered
      for (const m of mergedBoxes) {
        merged++
        if (WHITEOUT_DIAG) {
          // v0.8 §8 / v0.8.1: [ink-band] インクありセル数とレンジ束ね結果（ranges/split 追加）。
          console.log(
            `[whiteout-diag][ink-band] p${pageNo} band(y=${m.bandTop.toFixed(1)}) ` +
              `cellsIn=${m.cellsIn} labelCut=${m.labelCut} posLabelCut=${m.posLabelCut} ` +
              `emptyCut=${m.emptyCut} inkCells=${m.inkCells} writtenLeft=${m.writtenLeft.toFixed(1)} ` +
              `writtenRight=${m.writtenRight.toFixed(1)} labelRight=${m.labelRight.toFixed(1)} ` +
              `ranges=${m.rangeCount} split=${m.rangeIndex} ` +
              `rangeW=${m.bbox.w.toFixed(1)} mergedTo={${fmtBox(m.bbox)}}`,
          )
        }
        // v0.8.1 §3-P2: エリアA 記入欄の左端が罫線際 → 左辺を罫線内側へクランプ（記入欄左罫線被り）。
        pushInsetBox(pageNo, m.bbox, { left: true })
      }
    }
  }

  console.log(
    `[whiteout-diag-timing] suggestByField(ink O(cellArea))=${Date.now() - tSuggest}ms ` +
      `fields=${fieldBoxes.length} merged=${merged} painted=${boxes.length}`,
  )

  if (diag) {
    diag.areaA = areaA
    diag.areaB = areaB
    diag.labelExcluded = labelExcluded
    diag.posLabelExcluded = posLabelExcluded
    diag.inkFiltered = inkFiltered
    diag.merged = merged
    diag.painted = boxes.length
  }

  return boxes
}
