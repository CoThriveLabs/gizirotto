/**
 * 罫線ベース青枠スナップ — 画素直読ヘルパ（rule-based-snap.ts の分割先）。
 *
 * 画素は detectFieldBboxes が既に返した RGBA（追加デコード 0＝$0）を読むだけ。検出器 detectLines は
 * 呼ばない（無改変死守）。暗画素判定は検出器と同じ BINARIZE_LUMA_THRESHOLD（地色非依存・黒線/文字の二値）。
 * 座標は pt・左上原点。px↔pt は必ず pixels 側解像度（px.pixelWidth/px.pageWidthPt・scale2.0）で逆算する。
 *
 * 本ファイルは末端（rule-based-snap.ts を一切 import しない）。本体（rule-based-snap.ts）が
 * ここから boundingBox / overlap1D / 画素ヘルパを値 import する一方向構成（循環回避）。
 */
import type { Band } from './rule-based-snap'
import {
  type FieldBox,
  type RasterPagePixels,
  BINARIZE_LUMA_THRESHOLD,
} from '../parsers/pdf/field-bbox-detector'
import type { BboxPt } from './bbox-coords'

// =============================================================================
// P1.6b 本丸修正の snap ローカル const（検出器無改変・白塗り無影響）。
// 実値で原因確定: 真の右外枠=553.5pt(95%)・検出器が拾う 431(74%)は大枠右辺。最下部に画素横罫線
// 741/760/780 が見えるが検出器が帯化できていない → 画素で右端拡張＋帯分割する。
// =============================================================================

/**
 * NG1 右端拡張: bounded 右端から右へ画素探索し、帯ローカルでの縦最長ラン比
 * （maxRun / 帯高 px）がこれ以上の「最初の強い縦線」を真の右外枠とみなして右端を拡張する。
 * 帯ローカル（全高でなく bounded の y 範囲）で測るので他行の縦線を誤認しない。実機調整。
 */
const RIGHT_EXPAND_RUN_RATIO = 0.5

/**
 * NG-A 下端拡張: 最下部 area B 帯の下端から下へ画素探索し、帯ローカルでの横最長ラン比
 * （maxRun / 帯幅 px）がこれ以上なら「強い横線」とみなす閾値。RIGHT_EXPAND_RUN_RATIO の
 * 縦↔横 鏡像（同値）。最下部帯にしか適用しない（退行ガード）。
 * これで検出器が y680-760 で切った最下部帯を真の下罫線まで広げ、next_meeting 行
 * （≈760-790）を split が内部横罫線で割って自帯を持てるようにする。実機調整。
 */
const BOTTOM_EXPAND_RUN_RATIO = 0.5

/**
 * NG-A G1 白ギャップ許容上限（pt）。下端拡張で最深強線まで連続追従するとき、強線が途切れて
 * 白が続くのを許す最大幅。これ以下の白ギャップ（太線の二重検出・にじみ・1行ぶんの隙間）は
 * 跨いで次の強線まで追従し、超えたら追従打ち切り＝直近の強線で下端確定（空白セルを跨いで暴走しない）。
 * HLINE_SPLIT_MIN_GAP_PX(=6px) と同オーダー。pxPerPt=2.0 で 16pt≈32px ＝ next_meeting 1行分の
 * 行間（罫線間 ~20pt）を 1 つだけ跨げる最小限。
 */
const BOTTOM_EXPAND_MAX_GAP_PT = 16

/**
 * NG-A G2 拡張量の絶対上限（pt）。下端拡張は元 outer 下端からこの量までしか広げない。
 * dev 実値 760→790=+30pt なので 40pt 上限で next_meeting 1行ぶんに閉じ込む。超過なら無拡張。
 */
const BOTTOM_EXPAND_MAX_DELTA_PT = 40

/**
 * NG2/3 帯分割: area B 帯の内部で画素横罫線を探す閾値。行ごと暗画素数が
 * 帯幅 px × この比率以上なら横罫線とみなす（検出器 LINE_FILL_RATIO と同発想・snap ローカル）。
 */
const HLINE_SPLIT_FILL_RATIO = 0.5

/** NG2/3 帯分割: 近接する横罫線行を 1 本に間引く最小 y 間隔（px）。太線の二重検出防止。 */
const HLINE_SPLIT_MIN_GAP_PX = 6

/**
 * 案⑥（保険）画素プローブの外枠除外閾値（縦ラン比）。帯左端から右へ走査するとき、縦最長ラン比が
 * これ以上の列は「外周/内部の縦罫線（or 太い縦塊）」とみなしてスキップする（外枠 x25 等を弾く）。
 */
const PIXEL_PROBE_VLINE_RATIO = 0.8

/**
 * 案⑥（保険）画素プローブのラベル文字塊→空白 境界の暗画素数閾値（帯高 px に対する比）。
 * 列の暗画素数比がこれ未満に落ちた最初の x を「ラベル右側の空白開始＝記入欄左端」とみなす。
 * 🚨 フォント依存で脆い（文字の濃さ/サイズで暗画素密度が変わる）。案⑦（areaA borrow）が
 * 取れるページではそちらが優先され、本プローブは areaA 不在ページのみの保険。
 * TODO（チューニング）: areaA 不在テンプレが実機で出たら、実フォント/解像度で 0.06 を再調整する
 *   （薄字で空白誤検出するなら下げ、濃い地紋で誤反応するなら上げる）。現状は dev 実値未確認の暫定値。
 */
const PIXEL_PROBE_LABEL_DARK_RATIO = 0.06

/** 2 区間 [a1,a2] と [b1,b2] の重なり長（重ならなければ 0）。 */
export function overlap1D(a1: number, a2: number, b1: number, b2: number): number {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1))
}

/**
 * (F) セル群の外接矩形（pt）。area B 大枠も帯セルの実 y/h を採用するため、
 * y/h は range 内セルの min top 〜 max bottom をそのまま使う（AI bbox の過大 h を解消）。
 */
export function boundingBox(cells: FieldBox[]): BboxPt {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const c of cells) {
    left = Math.min(left, c.bbox.x)
    top = Math.min(top, c.bbox.y)
    right = Math.max(right, c.bbox.x + c.bbox.w)
    bottom = Math.max(bottom, c.bbox.y + c.bbox.h)
  }
  return { x: left, y: top, w: right - left, h: bottom - top }
}

/** 画素 (x,y) の luma（整数近似・検出器と同式）。範囲外は 255（白扱い）。 */
function lumaAt(px: RasterPagePixels, xPx: number, yPx: number): number {
  if (xPx < 0 || yPx < 0 || xPx >= px.pixelWidth || yPx >= px.pixelHeight) return 255
  const i = (yPx * px.pixelWidth + xPx) * 4
  const d = px.data
  return (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8
}

/**
 * その x 列を全高（または [y0Px,y1Px)）スキャンし、暗画素総数 darkCount と縦方向最長連続ラン
 * maxRun を返す（フル解像度 pixels.data を直読・検出器 detectLines は呼ばない＝無改変死守）。
 */
function columnDarkStats(
  px: RasterPagePixels,
  xPx: number,
  y0Px: number,
  y1Px: number,
): { darkCount: number; maxRun: number } {
  let darkCount = 0
  let run = 0
  let maxRun = 0
  for (let y = y0Px; y < y1Px; y++) {
    if (lumaAt(px, xPx, y) <= BINARIZE_LUMA_THRESHOLD) {
      darkCount++
      run++
      if (run > maxRun) maxRun = run
    } else {
      run = 0
    }
  }
  return { darkCount, maxRun }
}

/**
 * NG1 右端拡張（P1.6b）。bounded 右端から右へ画素探索し、bounded の帯ローカル y 範囲で
 * 縦最長ラン比（maxRun / 帯高 px）が RIGHT_EXPAND_RUN_RATIO 以上の「最初の強い縦線」を
 * 真の右外枠とみなして右端だけ置換する（左/上/下は不変）。見つからねば bounded のまま（退行なし）。
 *
 * 検出器が拾う 431(74%)=大枠右辺の右に、真の外周罫線 553.5(95%) があるケースを画素で吸収する。
 * y 帯は全高でなく bounded のローカル範囲を使う（他行の縦線を真の外枠と誤認しない）。
 * px↔pt は pixels 側解像度（pixels.pixelWidth / pixels.pageWidthPt・scale2.0 ラスタ基準）。
 */
export function expandRightEdgeByPixels(bounded: BboxPt, px: RasterPagePixels): BboxPt {
  const pxPerPt = px.pixelWidth / px.pageWidthPt
  const pyPerPt = px.pixelHeight / px.pageHeightPt
  const y0Px = Math.max(0, Math.round(bounded.y * pyPerPt))
  const y1Px = Math.min(px.pixelHeight, Math.round((bounded.y + bounded.h) * pyPerPt))
  const bandHpx = y1Px - y0Px
  if (bandHpx <= 0) return bounded

  const rightPtNow = bounded.x + bounded.w
  const startXpx = Math.round(rightPtNow * pxPerPt)
  for (let xPx = startXpx + 1; xPx < px.pixelWidth; xPx++) {
    const { maxRun } = columnDarkStats(px, xPx, y0Px, y1Px)
    if (maxRun / bandHpx >= RIGHT_EXPAND_RUN_RATIO) {
      const newRightPt = xPx / pxPerPt
      // 念のため右へ拡張のみ（新右端が現右端以下なら拡張しない＝退行ガード）。
      if (newRightPt > rightPtNow) {
        return { ...bounded, w: newRightPt - bounded.x }
      }
      break
    }
  }
  return bounded
}

/**
 * その y 行を全幅（または [x0Px,x1Px)）スキャンし、暗画素総数 darkCount と横方向最長連続ラン
 * maxRun を返す（columnDarkStats の縦↔横 鏡像・フル解像度 pixels.data 直読・detectLines 非呼出）。
 */
function rowDarkStats(
  px: RasterPagePixels,
  yPx: number,
  x0Px: number,
  x1Px: number,
): { darkCount: number; maxRun: number } {
  let darkCount = 0
  let run = 0
  let maxRun = 0
  for (let x = x0Px; x < x1Px; x++) {
    if (lumaAt(px, x, yPx) <= BINARIZE_LUMA_THRESHOLD) {
      darkCount++
      run++
      if (run > maxRun) maxRun = run
    } else {
      run = 0
    }
  }
  return { darkCount, maxRun }
}

/**
 * NG-A 下端拡張（案A・最深線追従）。bounded 下端から下へ画素探索し、bounded の帯ローカル x 範囲で
 * 横最長ラン比（maxRun / 帯幅 px）が BOTTOM_EXPAND_RUN_RATIO 以上の「強い横線」を辿り、
 * 連続する最深の強線（＝真の外周下罫線）まで下端だけ置換する（左/右/上は不変）。
 * その間の中間線は内部に残し、後段 split が内部横罫線として拾って next_meeting 行を割れるようにする。
 *
 * expandRightEdgeByPixels の縦↔横 鏡像。ただし右端は中間縦線が出ないため「最初の線」で足りるのに対し、
 * 下端は検出帯直下に中間仕切り線が出るので「最深線まで追従」する。
 * 過剰拡張防止ガード:
 *   - G1: 強線が途切れて続く白ギャップが BOTTOM_EXPAND_MAX_GAP_PT を超えたら追従打ち切り
 *         （直近の強線で下端確定・空白セルを跨いで暴走しない）。
 *   - G2: 元 outer 下端からの拡張量が BOTTOM_EXPAND_MAX_DELTA_PT を超えるなら無拡張（next_meeting 1行に閉じ込む）。
 *   - G3: 拡張後下端は pageHeightPt 超過禁止（クランプでなく超過検出時は無拡張）。
 *   - G4: G1/G2 内に有効な強線が 1 本も無ければ拡張前 outer を返す（退行ゼロ）。
 * x 帯は全幅でなく bounded のローカル範囲を使う（他列の横線を真の下外枠と誤認しない）。
 * px↔pt は pixels 側解像度（pixels.pixelHeight / pixels.pageHeightPt・scale2.0 ラスタ基準）。
 */
export function expandBottomEdgeByPixels(bounded: BboxPt, px: RasterPagePixels): BboxPt {
  const pxPerPt = px.pixelWidth / px.pageWidthPt
  const pyPerPt = px.pixelHeight / px.pageHeightPt
  const x0Px = Math.max(0, Math.round(bounded.x * pxPerPt))
  const x1Px = Math.min(px.pixelWidth, Math.round((bounded.x + bounded.w) * pxPerPt))
  const bandWpx = x1Px - x0Px
  if (bandWpx <= 0) return bounded

  const botPtNow = bounded.y + bounded.h
  const startYpx = Math.round(botPtNow * pyPerPt)
  const maxGapPx = Math.max(1, Math.round(BOTTOM_EXPAND_MAX_GAP_PT * pyPerPt))
  const maxBotPx = (botPtNow + BOTTOM_EXPAND_MAX_DELTA_PT) * pyPerPt

  // 最深の強線を追従: 強線を見つけるたび deepest を更新し、白ギャップが maxGapPx を超えたら打ち切り。
  let deepestStrongYpx = -1
  let gapSinceStrong = 0
  for (let yPx = startYpx + 1; yPx < px.pixelHeight; yPx++) {
    // G2: 拡張量上限を超える深さまで来たら探索終了（それ以上は救済対象外）。
    if (yPx > maxBotPx) break
    const { maxRun } = rowDarkStats(px, yPx, x0Px, x1Px)
    if (maxRun / bandWpx >= BOTTOM_EXPAND_RUN_RATIO) {
      deepestStrongYpx = yPx
      gapSinceStrong = 0
    } else if (deepestStrongYpx >= 0) {
      // G1: 一度強線を捉えた後の白ギャップを計測。上限超過で追従打ち切り（直近 deepest で確定）。
      gapSinceStrong++
      if (gapSinceStrong > maxGapPx) break
    }
  }

  // G4: 有効な強線なし → 無拡張（退行ゼロ）。
  if (deepestStrongYpx < 0) return bounded

  const newBotPt = deepestStrongYpx / pyPerPt
  const delta = newBotPt - botPtNow
  // 下へ拡張のみ（退行ガード）＋ G2 絶対上限 ＋ G3 ページ下端超過なら無拡張。
  if (delta <= 0 || delta > BOTTOM_EXPAND_MAX_DELTA_PT || newBotPt > px.pageHeightPt) {
    return bounded
  }
  return { ...bounded, h: newBotPt - bounded.y }
}

/**
 * NG2/3 帯分割（P1.6b）。area B 帯の内部（両端を除く）で画素横罫線を探し、見つかった y で
 * 帯セル bbox を y 方向の子帯へ分割する（各子帯 = 親の x 範囲 × 区切り y 範囲・area='B' 維持）。
 * 内部横罫線が無ければ分割しない（退行なし・帯をそのまま返す）。area A は呼び出し側で対象外。
 *
 * 検出器が帯化漏れした最下部 decisions 大枠（y680 始まり）を画素横罫線 741/760/780 で
 * decisions/attachments/next_meeting に割り、B2 ガード（small→自帯）で吸着を解消する。
 * 横罫線 = 行ごと暗画素数 >= 帯幅 px × HLINE_SPLIT_FILL_RATIO・近接 HLINE_SPLIT_MIN_GAP_PX 間引き。
 * px↔pt は pixels 側解像度（scale2.0 ラスタ基準）。
 */
export function splitBandBByPixelHLines(band: Band, px: RasterPagePixels): Band[] {
  if (band.cells.length === 0) return [band]
  const pxPerPt = px.pixelWidth / px.pageWidthPt
  const pyPerPt = px.pixelHeight / px.pageHeightPt

  // 帯の外接矩形（x 範囲は分割後の子帯にそのまま継承）。
  const outer = boundingBox(band.cells)
  const leftPx = Math.max(0, Math.round(outer.x * pxPerPt))
  const rightPx = Math.min(px.pixelWidth, Math.round((outer.x + outer.w) * pxPerPt))
  const topPx = Math.max(0, Math.round(outer.y * pyPerPt))
  const botPx = Math.min(px.pixelHeight, Math.round((outer.y + outer.h) * pyPerPt))
  const bandWpx = rightPx - leftPx
  if (bandWpx <= 0 || botPx - topPx <= 0) return [band]

  // 内部（両端を除く）で横罫線行を探索。両端は帯の外周罫線なので除外し内部分割線のみ拾う。
  const fillThr = bandWpx * HLINE_SPLIT_FILL_RATIO
  const innerHLinesPt: number[] = []
  let lastYpx = -HLINE_SPLIT_MIN_GAP_PX - 1
  for (let yPx = topPx + 1; yPx < botPx - 1; yPx++) {
    let dark = 0
    for (let xPx = leftPx; xPx < rightPx; xPx++) {
      if (lumaAt(px, xPx, yPx) <= BINARIZE_LUMA_THRESHOLD) dark++
    }
    if (dark >= fillThr && yPx - lastYpx > HLINE_SPLIT_MIN_GAP_PX) {
      innerHLinesPt.push(yPx / pyPerPt)
      lastYpx = yPx
    }
  }
  if (innerHLinesPt.length === 0) return [band]

  // 区切り y（帯上端 → 内部横罫線 … → 帯下端）で子帯セルを作る（x は親範囲継承・area='B'）。
  const page = band.cells[0].page
  const yEdges = [outer.y, ...innerHLinesPt, outer.y + outer.h]
  const childBands: Band[] = []
  for (let i = 0; i < yEdges.length - 1; i++) {
    const yTop = yEdges[i]
    const yBot = yEdges[i + 1]
    const h = yBot - yTop
    if (h <= 0) continue
    childBands.push({
      cells: [
        {
          page,
          area: 'B',
          bbox: { x: outer.x, y: yTop, w: outer.w, h },
        },
      ],
    })
  }
  return childBands.length > 0 ? childBands : [band]
}

/**
 * 案⑥（保険）画素プローブ。expanded の帯ローカル y 範囲で帯左端から右へ列走査し、
 * 外枠/縦罫線列（縦ラン比 ≥ PIXEL_PROBE_VLINE_RATIO）は飛ばしつつ、いったんラベル文字塊
 * （暗画素あり）を通過した後に暗画素比が PIXEL_PROBE_LABEL_DARK_RATIO 未満へ落ちた最初の x を
 * 「ラベル右側の空白開始＝記入欄左端」として返す。文字塊に当たらない/空白化しなければ null。
 * 既存 px 直読・detectLines 非呼出＝$0。px↔pt は pixels 側解像度（scale2.0 基準）。
 * 🚨 フォント依存で脆いため areaA borrow が取れないページのみの保険（呼び出し側で順序保証）。
 */
export function probeAreaBEntryLeftByPixels(expanded: BboxPt, px: RasterPagePixels): number | null {
  const pxPerPt = px.pixelWidth / px.pageWidthPt
  const pyPerPt = px.pixelHeight / px.pageHeightPt
  const y0Px = Math.max(0, Math.round(expanded.y * pyPerPt))
  const y1Px = Math.min(px.pixelHeight, Math.round((expanded.y + expanded.h) * pyPerPt))
  const bandHpx = y1Px - y0Px
  const leftPx = Math.max(0, Math.round(expanded.x * pxPerPt))
  const rightPx = Math.min(px.pixelWidth, Math.round((expanded.x + expanded.w) * pxPerPt))
  if (bandHpx <= 0 || rightPx - leftPx <= 0) return null

  const darkThr = bandHpx * PIXEL_PROBE_LABEL_DARK_RATIO
  let seenLabelInk = false
  for (let xPx = leftPx; xPx < rightPx; xPx++) {
    const { darkCount, maxRun } = columnDarkStats(px, xPx, y0Px, y1Px)
    // 外枠/縦罫線列はスキップ（ラベル塊・空白判定に混ぜない）。
    if (maxRun / bandHpx >= PIXEL_PROBE_VLINE_RATIO) continue
    if (darkCount >= darkThr) {
      seenLabelInk = true
    } else if (seenLabelInk) {
      // ラベル文字塊を通過後、暗画素が空白レベルへ落ちた最初の x ＝ 記入欄左端候補。
      return xPx / pxPerPt
    }
  }
  return null
}
