/**
 * suggestWhiteoutCandidatesByField unit test。
 *
 * インク検出アプローチ: 記入有無を OCR written → セル内インク（前景ピクセル）有無で判定。
 * OCR が固有名詞・手書きを検出できないため、インクは「局所背景より濃い前景」を相対判定
 * （背景色非依存）。
 *
 * シグネチャ: (fieldBoxes, cluster, classifications, ocr?, diag?, pixelsByPage?)
 *
 * インク判定 hasInkInCell 単体（合成 ImageData）:
 *   I1. 白地 + セル中央に濃画素塊 → hasInk=true（記入あり）
 *   I2. グレー地（luma≈210 一様）でインク無し → hasInk=false（背景色非依存の核心。地色がグレーでも塗らない）
 *   I3. グレー地 + 濃画素塊 → hasInk=true（地色に関わらず前景で判定）
 *   I4. 罫線（セル際の黒線）のみ・内側は地色 → margin で除外し hasInk=false
 *   I5. 点ノイズ 1 画素 → INK_MIN_DENSITY 未満で hasInk=false
 * 束ね / 空欄保護 / ラベル除外 / 罫線4px内側 inset:
 *   I6. 帯内「ラベル|記入|空白|記入」を ink レンジ束ねで 1 枠（文字間空白で切らない・ラベル/末尾空欄含まない）
 *   I7. インク 0 件の帯 → 束ね 0 件（空欄保護）
 *   I8. エリアB 大枠: インクあり→塗る / インク無し→塗らない
 *   I9. 全辺 inset（左右 INSET_LEFT/RIGHT_PT・上下 INSET_TOP/BOTTOM_PT）+ エリアB 下辺 lineFix
 *   I10. pixels 無指定（後方互換）: 記入判定不能 → エリアB は塗らない（空欄保護側）
 *   I11. ラベルセル（cluster）はインクがあっても塗らない / I12. INK_MIN_DENSITY 境界
 * 横並び分割 / range 最左ラベル除外 / inset+被り辺補正:
 *   J1. 横並び分割: 1帯「部署記入|大ギャップ|氏名記入」→ 2 枠に分割（項目をまたがない）
 *   J2. range 最左ラベル除外: 帯内グローバル最左でない range 最左狭セルを位置のみで除外（背景色非依存）
 *   J4. inset 3px + 被り辺補正: 塗り矩形が左右 3px 内側 + 被り辺は LINE_OVERLAP_FIX_PX 補正
 * 分割閾値 / 列分散度 / 端列縦ラン除去 / maxComponent:
 *   K1. 分割閾値28: ギャップ32→2 range / ギャップ22→1 range（境界値テスト）
 *   K2. 列分散度ラベル除外: 幅狭+colHist 分散→記入残す / 幅狭+colHist 偏在→ラベル除外（白/グレー同結果）
 *   K3. 端列縦ラン除去: 端罫線のみ→hasInk=false / 中央記入+端罫線混在→記入で hasInk=true（氏名両立の核心）
 *   K4. maxComponent: 散在小成分→hasInk=false / 大成分（記入）→true
 *   K5. 背景色非依存総合: K2/K3 を白地・グレー地で同判定
 */
import { describe, it, expect } from 'vitest'
import {
  suggestWhiteoutCandidatesByField,
  DEFAULT_BG_COLOR_WHITE,
  type FieldSuggestDiag,
} from '@/lib/parsers/pdf/whiteout-pipeline'
import {
  INSET_LEFT_PT,
  INSET_RIGHT_PT,
  INSET_TOP_PT,
  INSET_BOTTOM_PT,
  INK_MIN_DENSITY,
  BAND_RANGE_SPLIT_GAP_PT,
  LINE_OVERLAP_FIX_PX,
  LABEL_COLHIST_ZERO_MAX,
  VLINE_RESIDUE_RUN_RATIO,
  INK_MIN_COMPONENT,
  type FieldBox,
  type RasterPagePixels,
} from '@/lib/parsers/pdf/field-bbox-detector'
import type { LayoutCluster, LayoutCell } from '@/lib/parsers/pdf/layout-cluster'

function makeCell(
  cellId: string,
  bbox: { x: number; y: number; w: number; h: number },
  overrides: Partial<LayoutCell> = {},
): LayoutCell {
  return {
    cellId,
    page: overrides.page ?? 1,
    rowIndex: overrides.rowIndex ?? 0,
    colIndex: overrides.colIndex ?? 0,
    text: overrides.text ?? '',
    bbox,
    isLeftmostInRow: overrides.isLeftmostInRow ?? false,
    looksEmpty: overrides.looksEmpty ?? false,
    labelLexiconHit: overrides.labelLexiconHit ?? false,
    avgConfidence: overrides.avgConfidence ?? 0.9,
  }
}

/**
 * 合成ラスタ画素（RasterPagePixels）ビルダ。
 * テスト座標を分かりやすくするため 1pt = 1px（pageWidthPt=pixelWidth）にする。
 * 既定で全面を背景 luma（bg）で塗り、rects で指定領域を濃画素（ink luma）で塗る。
 */
function makePixels(opts: {
  width: number
  height: number
  bg?: number // 背景 luma（白≈255 / グレー≈210）。RGB 同値で埋める。
  inkLuma?: number // 前景（記入インク）luma。既定 30（濃い）。
  rects?: Array<{ x: number; y: number; w: number; h: number }>
  page?: number
}): RasterPagePixels {
  const { width, height } = opts
  const bg = opts.bg ?? 255
  const inkLuma = opts.inkLuma ?? 30
  const data = new Uint8ClampedArray(width * height * 4)
  // 背景一様塗り（R=G=B=bg, A=255）。luma 近似 (R*77+G*150+B*29)>>8 は R=G=B=bg のとき bg。
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = bg
    data[i * 4 + 1] = bg
    data[i * 4 + 2] = bg
    data[i * 4 + 3] = 255
  }
  // インク矩形を濃画素で上書き。
  for (const r of opts.rects ?? []) {
    const x1 = Math.min(width, r.x + r.w)
    const y1 = Math.min(height, r.y + r.h)
    for (let y = Math.max(0, r.y); y < y1; y++) {
      for (let x = Math.max(0, r.x); x < x1; x++) {
        const i = (y * width + x) * 4
        data[i] = inkLuma
        data[i + 1] = inkLuma
        data[i + 2] = inkLuma
      }
    }
  }
  return {
    page: opts.page ?? 1,
    data,
    pixelWidth: width,
    pixelHeight: height,
    pageWidthPt: width, // 1pt=1px
    pageHeightPt: height,
  }
}

function emptyDiag(): FieldSuggestDiag {
  return {
    areaA: 0,
    areaB: 0,
    labelExcluded: 0,
    posLabelExcluded: 0,
    inkFiltered: 0,
    merged: 0,
    painted: 0,
  }
}

const PAGE_W = 600
const PAGE_H = 800

describe('suggestWhiteoutCandidatesByField（インク検出・背景色非依存）', () => {
  it('I1: 白地 + セル中央に濃画素塊 → hasInk=true で塗られる', () => {
    // エリアB 大枠 x=100..300 y=50..150（白地）。中央 x=170..230 y=80..120 に濃画素塊（記入インク）。
    const fieldBoxes: FieldBox[] = [
      { page: 1, area: 'B', bbox: { x: 100, y: 50, w: 200, h: 100 } },
    ]
    const pixels = makePixels({
      width: PAGE_W,
      height: PAGE_H,
      bg: 255,
      rects: [{ x: 170, y: 80, w: 60, h: 40 }],
    })
    const diag = emptyDiag()
    const boxes = suggestWhiteoutCandidatesByField(
      fieldBoxes,
      { pages: [] },
      [],
      undefined,
      diag,
      [pixels],
    )
    expect(boxes.length).toBe(1)
    expect(diag.inkFiltered).toBe(0)
    expect(boxes[0].bbox.x).toBeCloseTo(100 + INSET_LEFT_PT, 5)
  })

  it('🚨 I2: グレー地（luma≈210 一様）でインク無し → hasInk=false で塗らない（背景色非依存の核心）', () => {
    // 地色がグレー（luma≈210）でも、記入インク（前景）が無ければ塗らない。
    // 背景色の絶対値で塗る塗らないを決めない（背景色非依存）。
    const fieldBoxes: FieldBox[] = [
      { page: 1, area: 'B', bbox: { x: 100, y: 50, w: 200, h: 100 } },
    ]
    // グレー一様（rects なし＝前景無し）。
    const pixels = makePixels({ width: PAGE_W, height: PAGE_H, bg: 210, rects: [] })
    const diag = emptyDiag()
    const boxes = suggestWhiteoutCandidatesByField(
      fieldBoxes,
      { pages: [] },
      [],
      undefined,
      diag,
      [pixels],
    )
    expect(boxes.length).toBe(0)
    expect(diag.inkFiltered).toBe(1)
  })

  it('I3: グレー地 + 濃画素塊 → hasInk=true（地色に関わらず前景で判定）', () => {
    // 地色がグレーでも、前景の記入インクがあれば塗る（背景の絶対値ではなく相対の濃さで判定）。
    const fieldBoxes: FieldBox[] = [
      { page: 1, area: 'B', bbox: { x: 100, y: 50, w: 200, h: 100 } },
    ]
    const pixels = makePixels({
      width: PAGE_W,
      height: PAGE_H,
      bg: 210,
      inkLuma: 30, // 背景 210 より INK_LUMA_DELTA(60) 以上濃い
      rects: [{ x: 170, y: 80, w: 60, h: 40 }],
    })
    const diag = emptyDiag()
    const boxes = suggestWhiteoutCandidatesByField(
      fieldBoxes,
      { pages: [] },
      [],
      undefined,
      diag,
      [pixels],
    )
    expect(boxes.length).toBe(1)
    expect(diag.inkFiltered).toBe(0)
  })

  it('I4: 罫線（セル際の黒線）のみ・内側は地色 → INK_BORDER_MARGIN_PX 除外で hasInk=false', () => {
    // セル外周 2px だけ黒罫線。内側は白地で前景無し。margin で罫線を走査外にして塗らない。
    const fieldBoxes: FieldBox[] = [
      { page: 1, area: 'B', bbox: { x: 100, y: 50, w: 200, h: 100 } },
    ]
    // セル全体を黒で塗ってから内側を白で戻す＝外周だけ黒罫線（margin 4px で外周は走査外）。
    const data = makePixels({ width: PAGE_W, height: PAGE_H, bg: 255 })
    // 外周 2px 黒線を描く（上下左右）。
    const W = PAGE_W
    const setBlack = (x: number, y: number) => {
      const i = (y * W + x) * 4
      data.data[i] = 0
      data.data[i + 1] = 0
      data.data[i + 2] = 0
    }
    for (let t = 0; t < 2; t++) {
      for (let x = 100; x < 300; x++) {
        setBlack(x, 50 + t)
        setBlack(x, 149 - t)
      }
      for (let y = 50; y < 150; y++) {
        setBlack(100 + t, y)
        setBlack(299 - t, y)
      }
    }
    const diag = emptyDiag()
    const boxes = suggestWhiteoutCandidatesByField(
      fieldBoxes,
      { pages: [] },
      [],
      undefined,
      diag,
      [data],
    )
    // 外周罫線は margin(4px) で走査外 → 内側白地のみ → インク無し → 塗らない
    expect(boxes.length).toBe(0)
    expect(diag.inkFiltered).toBe(1)
  })

  it('I5: 点ノイズ（数画素）→ INK_MIN_DENSITY 未満で hasInk=false', () => {
    // 走査領域に対しごく少数の濃画素（密度 < INK_MIN_DENSITY）はノイズとして塗らない。
    const fieldBoxes: FieldBox[] = [
      { page: 1, area: 'B', bbox: { x: 100, y: 50, w: 200, h: 100 } },
    ]
    // 走査領域 ≈ (200-8)*(100-8)=17664px、step2 で約4416サンプル。INK_MIN_DENSITY=0.008 → 約35画素相当。
    // 2x2=4px の濃点1つ（step2 で1サンプル程度）は密度 << 0.008。
    const pixels = makePixels({
      width: PAGE_W,
      height: PAGE_H,
      bg: 255,
      rects: [{ x: 198, y: 98, w: 2, h: 2 }],
    })
    const diag = emptyDiag()
    const boxes = suggestWhiteoutCandidatesByField(
      fieldBoxes,
      { pages: [] },
      [],
      undefined,
      diag,
      [pixels],
    )
    expect(boxes.length).toBe(0)
    expect(diag.inkFiltered).toBe(1)
  })

  it('I6: 帯内「ラベル|記入|空白|記入」を ink レンジ束ねで 1 枠（文字間空白で切らず・ラベル/末尾空欄含まない）', () => {
    // 帯 y=200。cell0 ラベル列（最左狭・位置除外）。cell1 記入 / cell2 空白 / cell3 記入 / cell4 末尾空欄。
    // 同一記入欄内の文字間空白では切らないことを検証するため、インクセル(cell1/cell3)間ギャップが
    // BAND_RANGE_SPLIT_GAP_PT 未満になるよう近接配置。
    // v0.8.2: 閾値が 40→28 に下がったため、cell1 右端 260 → cell3 左端 280 = ギャップ20 < 28 に詰める
    //（旧 v0.8.1 の 30 は 28 超で分割されてしまうため）。記入セルは幅広（w=150・0.25 > POS_LABEL_MAX_W_RATIO=0.22）。
    const fieldBoxes: FieldBox[] = [
      { page: 1, area: 'A', bbox: { x: 30, y: 200, w: 60, h: 30 } }, // cell0 ラベル列（最左狭・右端90）
      { page: 1, area: 'A', bbox: { x: 110, y: 200, w: 150, h: 30 } }, // cell1 記入（幅広・右端 260）
      { page: 1, area: 'A', bbox: { x: 260, y: 200, w: 20, h: 30 } }, // cell2 空白（260..280）
      { page: 1, area: 'A', bbox: { x: 280, y: 200, w: 150, h: 30 } }, // cell3 記入（幅広・左端 280・ギャップ20<28）
      { page: 1, area: 'A', bbox: { x: 430, y: 200, w: 60, h: 30 } }, // cell4 末尾空欄
    ]
    // cell1, cell3 にインク塊（文字相当の小塊・走査領域の過半を覆わない）。cell2(空白)・cell4(末尾空欄) はインク無し。
    const pixels = makePixels({
      width: PAGE_W,
      height: PAGE_H,
      bg: 255,
      rects: [
        { x: 130, y: 210, w: 24, h: 12 }, // cell1 内
        { x: 300, y: 210, w: 24, h: 12 }, // cell3 内（左端280..右端430）
      ],
    })
    const diag = emptyDiag()
    const boxes = suggestWhiteoutCandidatesByField(
      fieldBoxes,
      { pages: [] },
      [],
      undefined,
      diag,
      [pixels],
    )
    // インクありレンジ [110, 430) を 1 枠（cell2 空白で切らない・cell0 ラベル/cell4 末尾空欄含まない）
    expect(boxes.length).toBe(1)
    expect(diag.merged).toBe(1)
    expect(diag.posLabelExcluded).toBe(1) // cell0 のみ（cell1 は幅広で range 最左ラベルにならない）
    const b = boxes[0].bbox
    // エリアA 左辺は罫線被り補正(LINE_OVERLAP_FIX_PX)後に inset。
    expect(b.x).toBeCloseTo(110 + LINE_OVERLAP_FIX_PX + INSET_LEFT_PT, 5)
    // cell3 を x=280 に詰めた（ギャップ20<28）→ レンジ右端 = cell3 右端 430。右辺は inset のみ（lineFix なし）。
    expect(b.x + b.w).toBeCloseTo(430 - INSET_RIGHT_PT, 5)
  })

  it('I7: インク 0 件の帯 → 束ね 0 件（空欄保護・議題/添付/次回相当）', () => {
    // 記入欄細セルだが全セルでインク無し → 1 枠も作らない。
    const fieldBoxes: FieldBox[] = [
      { page: 1, area: 'A', bbox: { x: 100, y: 300, w: 100, h: 30 } },
      { page: 1, area: 'A', bbox: { x: 200, y: 300, w: 100, h: 30 } },
      { page: 1, area: 'A', bbox: { x: 300, y: 300, w: 100, h: 30 } },
    ]
    const pixels = makePixels({ width: PAGE_W, height: PAGE_H, bg: 255, rects: [] })
    const diag = emptyDiag()
    const boxes = suggestWhiteoutCandidatesByField(
      fieldBoxes,
      { pages: [] },
      [],
      undefined,
      diag,
      [pixels],
    )
    expect(boxes.length).toBe(0)
    expect(diag.merged).toBe(0)
  })

  it('I8: エリアB 大枠（インクあり→塗る / インク無し→塗らない）', () => {
    const fieldBoxes: FieldBox[] = [
      { page: 1, area: 'B', bbox: { x: 50, y: 50, w: 200, h: 100 } }, // インクあり
      { page: 1, area: 'B', bbox: { x: 300, y: 50, w: 200, h: 100 } }, // インク無し（空欄）
    ]
    const pixels = makePixels({
      width: PAGE_W,
      height: PAGE_H,
      bg: 255,
      rects: [{ x: 120, y: 80, w: 60, h: 40 }], // 左の大枠のみ
    })
    const diag = emptyDiag()
    const boxes = suggestWhiteoutCandidatesByField(
      fieldBoxes,
      { pages: [] },
      [],
      undefined,
      diag,
      [pixels],
    )
    expect(boxes.length).toBe(1)
    expect(boxes[0].bbox.x).toBeCloseTo(50 + INSET_LEFT_PT, 5)
    expect(diag.inkFiltered).toBe(1) // 右の空欄大枠
  })

  it('I9: 全辺 inset（左右 INSET_LEFT/RIGHT_PT 同値、上下 INSET_TOP/BOTTOM_PT）。エリアB大枠も', () => {
    const fieldBoxes: FieldBox[] = [
      { page: 1, area: 'B', bbox: { x: 100, y: 50, w: 200, h: 100 } },
    ]
    const pixels = makePixels({
      width: PAGE_W,
      height: PAGE_H,
      bg: 255,
      rects: [{ x: 150, y: 80, w: 100, h: 40 }],
    })
    const boxes = suggestWhiteoutCandidatesByField(
      fieldBoxes,
      { pages: [] },
      [],
      undefined,
      undefined,
      [pixels],
    )
    expect(boxes.length).toBe(1)
    const b = boxes[0].bbox
    // x/y/w は inset のみ（エリアB の lineFix は下辺=P3 のみで x/y/w に影響しない）。
    expect(b.x).toBeCloseTo(100 + INSET_LEFT_PT, 5)
    expect(b.y).toBeCloseTo(50 + INSET_TOP_PT, 5)
    expect(b.w).toBeCloseTo(200 - INSET_LEFT_PT - INSET_RIGHT_PT, 5)
    // エリアB 大枠の下辺は罫線被り補正(LINE_OVERLAP_FIX_PX)後に inset → h がその分縮む。
    expect(b.h).toBeCloseTo(100 - INSET_TOP_PT - INSET_BOTTOM_PT - LINE_OVERLAP_FIX_PX, 5)
    expect(INSET_RIGHT_PT).toBe(INSET_LEFT_PT)
    expect(boxes[0].source).toBe('auto_suggestion')
    expect(boxes[0].estimatedBgColor).toEqual(DEFAULT_BG_COLOR_WHITE)
  })

  it('I10: pixels 無指定（後方互換）→ エリアB は記入判定不能で塗らない（空欄保護側）', () => {
    const fieldBoxes: FieldBox[] = [
      { page: 1, area: 'B', bbox: { x: 100, y: 50, w: 200, h: 100 } },
    ]
    const diag = emptyDiag()
    // pixels 無指定（第6引数なし）。
    const boxes = suggestWhiteoutCandidatesByField(fieldBoxes, { pages: [] }, [], undefined, diag)
    expect(boxes.length).toBe(0)
    expect(diag.inkFiltered).toBe(1)
  })

  it('I11: ラベルセル（cluster）はインクがあっても塗らない（ラベル印字をインクと誤らない）', () => {
    // ラベル列 field（cluster ラベルセルとほぼ一致）。ラベル印字のインクがあっても除外で塗らない。
    const fieldBoxes: FieldBox[] = [
      { page: 1, area: 'A', bbox: { x: 0, y: 0, w: 100, h: 40 } }, // ラベル列
      { page: 1, area: 'A', bbox: { x: 100, y: 0, w: 200, h: 40 } }, // 記入欄
    ]
    const cluster: LayoutCluster = {
      pages: [
        {
          page: 1,
          cells: [
            makeCell('lbl', { x: 10, y: 10, w: 80, h: 20 }, {
              isLeftmostInRow: true,
              labelLexiconHit: true,
              text: '部署',
            }),
          ],
        },
      ],
    }
    // ラベル列にも記入欄にもインク（ラベルは印字インク・記入欄は記入インク）。
    const pixels = makePixels({
      width: PAGE_W,
      height: PAGE_H,
      bg: 255,
      rects: [
        { x: 20, y: 14, w: 50, h: 14 }, // ラベル印字
        { x: 150, y: 12, w: 80, h: 16 }, // 記入欄
      ],
    })
    const diag = emptyDiag()
    const boxes = suggestWhiteoutCandidatesByField(
      fieldBoxes,
      cluster,
      [],
      undefined,
      diag,
      [pixels],
    )
    // ラベル列は除外、記入欄のみ塗る
    expect(boxes.length).toBe(1)
    expect(diag.labelExcluded + diag.posLabelExcluded).toBe(1)
    // エリアA 左辺は罫線被り補正(LINE_OVERLAP_FIX_PX)後に inset。
    expect(boxes[0].bbox.x).toBeCloseTo(100 + LINE_OVERLAP_FIX_PX + INSET_LEFT_PT, 5)
  })

  it('I12: INK_MIN_DENSITY 境界。十分広いインク塊は密度を満たし塗る', () => {
    // INK_MIN_DENSITY=0.008 を確実に超える広いインク塊（走査領域の数%）で塗られることを確認。
    const fieldBoxes: FieldBox[] = [
      { page: 1, area: 'B', bbox: { x: 100, y: 50, w: 200, h: 100 } },
    ]
    const pixels = makePixels({
      width: PAGE_W,
      height: PAGE_H,
      bg: 255,
      rects: [{ x: 140, y: 70, w: 120, h: 60 }], // 走査領域の十分な割合
    })
    const diag = emptyDiag()
    const boxes = suggestWhiteoutCandidatesByField(
      fieldBoxes,
      { pages: [] },
      [],
      undefined,
      diag,
      [pixels],
    )
    expect(boxes.length).toBe(1)
    // INK_MIN_DENSITY は妥当な小さい値（密度しきい）
    expect(INK_MIN_DENSITY).toBeGreaterThan(0)
    expect(INK_MIN_DENSITY).toBeLessThan(0.1)
  })

  it('J1: 横並び分割。「部署記入|大ギャップ|氏名記入」を 2 枠に分割（項目をまたがない）', () => {
    // 帯 y=400。cell_dept 記入（x=110 右端260）/ cell_name 記入（x=360 左端360）。
    // インクセル間ギャップ = 360-260 = 100 > BAND_RANGE_SPLIT_GAP_PT → 横並び項目境界で 2 range に分割。
    // 記入欄は幅広（w=150・150/600=0.25 > POS_LABEL_MAX_W_RATIO=0.22）にし range 最左ラベル誤除外を避ける。
    expect(100).toBeGreaterThan(BAND_RANGE_SPLIT_GAP_PT) // 前提: このギャップは閾値超
    const fieldBoxes: FieldBox[] = [
      { page: 1, area: 'A', bbox: { x: 110, y: 400, w: 150, h: 30 } }, // 部署記入（右端260）
      { page: 1, area: 'A', bbox: { x: 360, y: 400, w: 150, h: 30 } }, // 氏名記入（左端360）
    ]
    // インクは文字相当の小さな塊（走査領域の過半を覆わない＝最頻 luma が背景に保たれる）。
    const pixels = makePixels({
      width: PAGE_W,
      height: PAGE_H,
      bg: 255,
      rects: [
        { x: 130, y: 410, w: 24, h: 12 }, // 部署記入インク
        { x: 380, y: 410, w: 24, h: 12 }, // 氏名記入インク
      ],
    })
    const diag = emptyDiag()
    const boxes = suggestWhiteoutCandidatesByField(
      fieldBoxes,
      { pages: [] },
      [],
      undefined,
      diag,
      [pixels],
    )
    // 2 枠に分割（部署枠 / 氏名枠）。項目をまたいだ 1 枠にしない。
    expect(boxes.length).toBe(2)
    expect(diag.merged).toBe(2)
    const sorted = [...boxes].sort((a, b) => a.bbox.x - b.bbox.x)
    // 枠1（部署）: 左辺 lineFix + inset、右端 260 - inset。氏名区画をまたがない。
    expect(sorted[0].bbox.x).toBeCloseTo(110 + LINE_OVERLAP_FIX_PX + INSET_LEFT_PT, 5)
    expect(sorted[0].bbox.x + sorted[0].bbox.w).toBeCloseTo(260 - INSET_RIGHT_PT, 5)
    // 枠2（氏名）: 左辺 lineFix + inset、右端 510 - inset。
    expect(sorted[1].bbox.x).toBeCloseTo(360 + LINE_OVERLAP_FIX_PX + INSET_LEFT_PT, 5)
    expect(sorted[1].bbox.x + sorted[1].bbox.w).toBeCloseTo(510 - INSET_RIGHT_PT, 5)
  })

  it('🚨 J2: range 最左ラベル除外。帯内グローバル最左でない range 最左狭セルを位置のみで除外（地色非依存）', () => {
    // 帯 y=500。cell0 部署ラベル(最左狭・帯内グローバル最左) / cell1 部署記入 / 大ギャップ /
    // cell2 氏名ラベル(range#1 最左狭・グローバル最左ではない) / cell3 氏名記入。
    // 氏名ラベル(cell2)は帯内グローバル最左でないため従来 isPositionalLabel では除外漏れ
    // → range 最左ラベル除外(isPositionalLabelInRange)で落とす。地色は一切見ず位置と幅のみ。
    const fieldBoxes: FieldBox[] = [
      { page: 1, area: 'A', bbox: { x: 30, y: 500, w: 40, h: 30 } }, // cell0 部署ラベル（最左狭・右端70）
      { page: 1, area: 'A', bbox: { x: 100, y: 500, w: 150, h: 30 } }, // cell1 部署記入（幅広・右端250）
      { page: 1, area: 'A', bbox: { x: 370, y: 500, w: 40, h: 30 } }, // cell2 氏名ラベル（range#1最左狭・右端410）
      { page: 1, area: 'A', bbox: { x: 420, y: 500, w: 150, h: 30 } }, // cell3 氏名記入（幅広・左端420）
    ]
    // ギャップ cell1右端250 → cell2左端370 = 120 > 40（部署 range と氏名 range に分割）。
    expect(120).toBeGreaterThan(BAND_RANGE_SPLIT_GAP_PT)
    // ラベルにも記入欄にもインク（ラベルは印字インク・記入欄は記入インク）。ラベル除外は位置のみで効くこと。
    // インクは文字相当の小塊（走査領域の過半を覆わない＝最頻 luma が背景に保たれ inkRatio が正しく出る）。
    const rects = [
      { x: 40, y: 510, w: 16, h: 12 }, // cell0 部署ラベル印字
      { x: 120, y: 510, w: 24, h: 12 }, // cell1 部署記入
      { x: 380, y: 510, w: 16, h: 12 }, // cell2 氏名ラベル印字
      { x: 440, y: 510, w: 24, h: 12 }, // cell3 氏名記入
    ]
    // 地色を白(255)とグレー(210)で同一結果になることを確認（背景色非依存）。
    for (const bg of [255, 210]) {
      const pixels = makePixels({ width: PAGE_W, height: PAGE_H, bg, inkLuma: 30, rects })
      const diag = emptyDiag()
      const boxes = suggestWhiteoutCandidatesByField(
        fieldBoxes,
        { pages: [] },
        [],
        undefined,
        diag,
        [pixels],
      )
      // 部署記入・氏名記入の 2 枠のみ（部署ラベル・氏名ラベルは位置で除外）。
      expect(boxes.length, `bg=${bg}`).toBe(2)
      // posLabelExcluded=2（cell0 帯内グローバル最左 + cell2 range#1 最左）。
      expect(diag.posLabelExcluded, `bg=${bg}`).toBe(2)
      const sorted = [...boxes].sort((a, b) => a.bbox.x - b.bbox.x)
      // 枠1 部署記入: 左端は記入セル左端100（ラベル右端70より内側 = clamp 不要）+ lineFix + inset。
      expect(sorted[0].bbox.x, `bg=${bg}`).toBeCloseTo(100 + LINE_OVERLAP_FIX_PX + INSET_LEFT_PT, 5)
      // 枠2 氏名記入: 左端420（氏名ラベル右端410より内側）+ lineFix + inset。氏名ラベルを含まない。
      expect(sorted[1].bbox.x, `bg=${bg}`).toBeCloseTo(420 + LINE_OVERLAP_FIX_PX + INSET_LEFT_PT, 5)
    }
  })

  it('J4: inset 3px + 被り辺補正（エリアA 左辺 / エリアB 下辺）', () => {
    // INSET_LEFT/RIGHT_PT=3（左右 3px 内側）。inset とは別レイヤで被り辺を LINE_OVERLAP_FIX_PX 補正。
    expect(INSET_LEFT_PT).toBe(3)
    expect(INSET_RIGHT_PT).toBe(3)
    expect(LINE_OVERLAP_FIX_PX).toBeGreaterThan(0)

    // エリアA 記入欄（左辺 lineFix）。インクは文字相当の小塊。
    const areaA: FieldBox[] = [{ page: 1, area: 'A', bbox: { x: 100, y: 600, w: 200, h: 30 } }]
    const pxA = makePixels({
      width: PAGE_W,
      height: PAGE_H,
      bg: 255,
      rects: [{ x: 130, y: 610, w: 24, h: 12 }],
    })
    const boxesA = suggestWhiteoutCandidatesByField(areaA, { pages: [] }, [], undefined, undefined, [pxA])
    expect(boxesA.length).toBe(1)
    // 左辺 = +LINE_OVERLAP_FIX_PX（罫線被り補正）+INSET_LEFT_PT（3px）。右辺 = -INSET_RIGHT_PT のみ。
    expect(boxesA[0].bbox.x).toBeCloseTo(100 + LINE_OVERLAP_FIX_PX + INSET_LEFT_PT, 5)
    expect(boxesA[0].bbox.x + boxesA[0].bbox.w).toBeCloseTo(300 - INSET_RIGHT_PT, 5)

    // エリアB 大枠（下辺 lineFix）。
    const areaB: FieldBox[] = [{ page: 1, area: 'B', bbox: { x: 100, y: 600, w: 200, h: 100 } }]
    const pxB = makePixels({
      width: PAGE_W,
      height: PAGE_H,
      bg: 255,
      rects: [{ x: 140, y: 630, w: 120, h: 40 }],
    })
    const boxesB = suggestWhiteoutCandidatesByField(areaB, { pages: [] }, [], undefined, undefined, [pxB])
    expect(boxesB.length).toBe(1)
    // 上辺 = +INSET_TOP_PT のみ。下辺 = -INSET_BOTTOM_PT -LINE_OVERLAP_FIX_PX（罫線被り補正）。
    expect(boxesB[0].bbox.y).toBeCloseTo(600 + INSET_TOP_PT, 5)
    expect(boxesB[0].bbox.h).toBeCloseTo(100 - INSET_TOP_PT - INSET_BOTTOM_PT - LINE_OVERLAP_FIX_PX, 5)
  })

  it('K1: 分割閾値28。ギャップ32 → 2 range 分割 / ギャップ22 → 1 range 維持（境界値）', () => {
    // 部署|氏名 境界 32pt は割り、氏名項目内 22pt は割らない（22 < 28 <= 32）。
    expect(BAND_RANGE_SPLIT_GAP_PT).toBe(28)
    // 前提: 閾値は両者の中間。
    expect(32).toBeGreaterThan(BAND_RANGE_SPLIT_GAP_PT) // 割る
    expect(22).toBeLessThanOrEqual(BAND_RANGE_SPLIT_GAP_PT) // 割らない

    // --- ギャップ32（部署|氏名相当）→ 2 枠に分割。記入欄は幅広（w=150 > POS_LABEL_MAX_W_RATIO*600=132）。
    const fieldsGap32: FieldBox[] = [
      { page: 1, area: 'A', bbox: { x: 100, y: 400, w: 150, h: 30 } }, // 右端250
      { page: 1, area: 'A', bbox: { x: 282, y: 400, w: 150, h: 30 } }, // 左端282 = ギャップ32
    ]
    const px32 = makePixels({
      width: PAGE_W,
      height: PAGE_H,
      bg: 255,
      rects: [
        { x: 130, y: 410, w: 24, h: 12 },
        { x: 312, y: 410, w: 24, h: 12 },
      ],
    })
    const diag32 = emptyDiag()
    const boxes32 = suggestWhiteoutCandidatesByField(
      fieldsGap32,
      { pages: [] },
      [],
      undefined,
      diag32,
      [px32],
    )
    expect(boxes32.length, 'gap32 → 2 range').toBe(2)
    expect(diag32.merged).toBe(2)

    // --- ギャップ22（氏名項目内相当）→ 1 枠維持（同一記入欄を割らない）。
    const fieldsGap22: FieldBox[] = [
      { page: 1, area: 'A', bbox: { x: 100, y: 500, w: 150, h: 30 } }, // 右端250
      { page: 1, area: 'A', bbox: { x: 272, y: 500, w: 150, h: 30 } }, // 左端272 = ギャップ22
    ]
    const px22 = makePixels({
      width: PAGE_W,
      height: PAGE_H,
      bg: 255,
      rects: [
        { x: 130, y: 510, w: 24, h: 12 },
        { x: 302, y: 510, w: 24, h: 12 },
      ],
    })
    const diag22 = emptyDiag()
    const boxes22 = suggestWhiteoutCandidatesByField(
      fieldsGap22,
      { pages: [] },
      [],
      undefined,
      diag22,
      [px22],
    )
    expect(boxes22.length, 'gap22 → 1 range').toBe(1)
    expect(diag22.merged).toBe(1)
  })

  it('🚨 K2: 列分散度ラベル除外。幅狭+colHist分散→記入残す / 幅狭+colHist偏在→ラベル除外（白/グレー同結果）', () => {
    // 場所記入左(x=68 w73 分散)と氏名ラベル(w39 端偏在)はどちらも narrow。colHist のゼロ列数で区別する。
    // 実機に忠実な構成:
    //   - labelGlobal: 帯内グローバル最左の項目名ラベル（さらに狭い）。インク判定前の isPositionalLabel
    //     （colHist 無し・グローバル最左+幅狭）で除外される → range を構成する inkCells に入らない。
    //   - narrowCell: 場所記入左 相当（w73）。labelGlobal 除外後、インクセルの range#0 最左になり、
    //     isPositionalLabelInRange（colHist 分散度併用）の対象になる。
    //   - wideCell: 別項目の幅広記入（range#1。narrowCell とのギャップ > 28 で別 range）。
    // - ケースA: narrowCell が「全列に分散したインク」（場所記入左相当）→ 記入欄として残す（除外しない）。
    // - ケースB: narrowCell が「右側だけにインク（左列ゼロ）」（氏名ラベル相当）→ colHist 偏在でラベル除外。
    // 地色 白(255)/グレー(210) 両方で同結果（背景色非依存）。
    expect(LABEL_COLHIST_ZERO_MAX).toBe(3)

    // labelGlobal: 帯内グローバル最左の細ラベル（w30・グローバル最左 → (1) で除外）。
    const labelGlobal = { x: 20, y: 600, w: 30, h: 30 } // 右端50
    // narrowCell: 場所記入左 相当（w73 narrow・labelGlobal 右端50 とギャップ10<28 で同 range / インクセル最左）。
    const narrowCell = { x: 60, y: 600, w: 73, h: 30 } // 右端133
    // wideCell: 別項目の幅広記入（narrowCell 右端133 とギャップ167>28 で別 range）。
    const wideCell = { x: 300, y: 600, w: 150, h: 30 }

    // narrowCell 走査領域はセル内側 margin 後 x≈64..129（cols≈33・rows≈11）。8 分割で分散/偏在を作り分ける。
    // 分散: 全列に渡る横線を「薄く」（colHist 全 bin 非ゼロ＝ゼロ列0・実機の記入文字相当）。
    // 🚨 重要: 塊が走査領域の過半を覆うと**最頻 luma がインク色になり bgLuma が反転**して hasInk=false に
    //   なる（最頻値=地色 の前提が崩れる）。よって縦は薄く（走査高 rows≈11 のうち数サンプルだけ）し、
    //   塊面積を走査領域の半分未満に抑える（横は全列に渡して分散は保つ）。
    const fillSpread = (): Array<{ x: number; y: number; w: number; h: number }> => {
      // 内側 x66..127 に横長・縦薄（h6→約3サンプル）の塊。8 列すべてに画素が乗る（分散）が面積は走査領域の ~25%。
      return [{ x: 66, y: 612, w: 62, h: 6 }]
    }
    const fillRightConcentrated = (): Array<{ x: number; y: number; w: number; h: number }> => {
      // 右側だけに塊（左 3 列以上がゼロ＝偏在＝ラベル）。氏名ラベル[0,0,0,9,..] 相当。
      return [{ x: 112, y: 608, w: 16, h: 14 }]
    }

    for (const bg of [255, 210]) {
      // --- ケースA: narrowCell 分散（記入欄）→ 残す。posLabelExcluded=1（labelGlobal のみ）、枠2（narrowCell + wideCell）。
      const fieldsA: FieldBox[] = [
        { page: 1, area: 'A', bbox: labelGlobal },
        { page: 1, area: 'A', bbox: narrowCell },
        { page: 1, area: 'A', bbox: wideCell },
      ]
      const pxA = makePixels({
        width: PAGE_W,
        height: PAGE_H,
        bg,
        // labelGlobal にもインク（印字）。narrowCell 分散。wideCell 記入。
        rects: [
          { x: 28, y: 610, w: 14, h: 12 }, // labelGlobal 印字（(1) で除外されるのでインク有無は結果に無関係）
          ...fillSpread(),
          { x: 320, y: 610, w: 24, h: 12 },
        ],
      })
      const diagA = emptyDiag()
      const boxesA = suggestWhiteoutCandidatesByField(
        fieldsA,
        { pages: [] },
        [],
        undefined,
        diagA,
        [pxA],
      )
      expect(boxesA.length, `bg=${bg} caseA spread→keep`).toBe(2)
      // posLabelExcluded = labelGlobal（グローバル最左）のみ。narrowCell は colHist 分散で残る（除外されない）。
      expect(diagA.posLabelExcluded, `bg=${bg} caseA`).toBe(1)

      // --- ケースB: narrowCell 右偏在（ラベル）→ 除外。posLabelExcluded=2（labelGlobal + narrowCell）、枠1（wideCell）。
      const fieldsB: FieldBox[] = [
        { page: 1, area: 'A', bbox: labelGlobal },
        { page: 1, area: 'A', bbox: narrowCell },
        { page: 1, area: 'A', bbox: wideCell },
      ]
      const pxB = makePixels({
        width: PAGE_W,
        height: PAGE_H,
        bg,
        rects: [
          { x: 28, y: 610, w: 14, h: 12 }, // labelGlobal 印字
          ...fillRightConcentrated(),
          { x: 320, y: 610, w: 24, h: 12 },
        ],
      })
      const diagB = emptyDiag()
      const boxesB = suggestWhiteoutCandidatesByField(
        fieldsB,
        { pages: [] },
        [],
        undefined,
        diagB,
        [pxB],
      )
      expect(boxesB.length, `bg=${bg} caseB concentrated→exclude`).toBe(1)
      // posLabelExcluded = labelGlobal（グローバル最左）+ narrowCell（range#0 最左・colHist 偏在）。
      expect(diagB.posLabelExcluded, `bg=${bg} caseB`).toBe(2)
    }
  })

  it('🚨 K3: 端列縦ラン除去。端罫線のみ→hasInk=false / 中央記入+端罫線混在→記入で hasInk=true（氏名両立の核心）', () => {
    // 部署空欄 colHist=[80,0,..,64] maxRunCol=16（縦フルラン）= 左右縦罫線。端列縦ランを控除して density 評価。
    // セル x=100..300(w=200) y=200..280(h=80)。1pt=1px・INK_SCAN_STEP=2・margin4 → 走査 x104..296 y204..276。
    expect(VLINE_RESIDUE_RUN_RATIO).toBe(0.8)
    const cell: FieldBox = { page: 1, area: 'B', bbox: { x: 100, y: 200, w: 200, h: 80 } }

    // 実装は「端（最左/最右サンプル列）から内側へ縦フルランが続く限り控除」。罫線はセルの罫線際（margin 境界に
    // またがって残る縦罫線）= 走査の最左/最右サンプル列を含む位置に置く（実機に忠実）。縦は y=204..276 全体（rows 全部）。
    // 左罫線: 走査左端 x=104（c0）から内側へ数 px。右罫線: 走査右端 x=294（最右サンプル列）を含む位置まで。
    const leftVLine = { x: 104, y: 204, w: 6, h: 72 } // 左縦罫線（最左サンプル列 c0 を含む・縦フルラン）
    const rightVLine = { x: 290, y: 204, w: 6, h: 72 } // 右縦罫線（最右サンプル列 x294 を含む・縦フルラン）

    // --- ケースA: 端罫線のみ（中央記入なし）→ 端列控除後 effectiveInk≈0 → hasInk=false（部署空欄相当）。
    const pxRuleOnly = makePixels({
      width: PAGE_W,
      height: PAGE_H,
      bg: 255,
      rects: [leftVLine, rightVLine],
    })
    const diagRule = emptyDiag()
    const boxesRule = suggestWhiteoutCandidatesByField(
      [cell],
      { pages: [] },
      [],
      undefined,
      diagRule,
      [pxRuleOnly],
    )
    expect(boxesRule.length, 'edge rule only → skip').toBe(0)
    expect(diagRule.inkFiltered).toBe(1)

    // --- ケースB（核心）: 中央記入 + 端罫線混在 → 罫線だけ控除し中央記入で hasInk=true。
    // 中央 x=180..240(w60) y=220..250(h30) に記入塊（端列でないので控除されず残り maxComponent も大）。
    const pxMix = makePixels({
      width: PAGE_W,
      height: PAGE_H,
      bg: 255,
      rects: [leftVLine, rightVLine, { x: 180, y: 220, w: 60, h: 30 }],
    })
    const diagMix = emptyDiag()
    const boxesMix = suggestWhiteoutCandidatesByField(
      [cell],
      { pages: [] },
      [],
      undefined,
      diagMix,
      [pxMix],
    )
    expect(boxesMix.length, '🚨 center ink + edge rule → painted (氏名両立)').toBe(1)
    expect(diagMix.inkFiltered).toBe(0)
  })

  it('K4: maxComponent。散在小成分（添付ノイズ相当）→ hasInk=false / 大成分（記入）→ true', () => {
    // 散在ノイズ（小さな点が離れて散る）は maxComponent < INK_MIN_COMPONENT で落とす。記入（大きな塊）は残す。
    expect(INK_MIN_COMPONENT).toBeGreaterThan(2) // 散在(1-2)を落とし記入(大)を残す中間
    const cell: FieldBox = { page: 1, area: 'B', bbox: { x: 100, y: 200, w: 200, h: 100 } }

    // --- 散在小成分: 互いに離れた 2x2px 点を多数。各点は INK_SCAN_STEP=2 でサンプル空間でも極小成分
    // （1〜2 サンプル）。点を 12px 間隔で散らす → 連結しない（maxComponent < INK_MIN_COMPONENT）。
    // 密度は点数で INK_MIN_DENSITY を超えても maxComponent が小さく落ちることを検証
    //（密度 AND まとまりの「まとまり側」で落とす＝実機の部署空欄 0.0373 を maxComponent で落とす相当）。
    const scatterRects: Array<{ x: number; y: number; w: number; h: number }> = []
    for (let gy = 0; gy < 12; gy++) {
      for (let gx = 0; gx < 12; gx++) {
        scatterRects.push({ x: 120 + gx * 12, y: 220 + gy * 6, w: 2, h: 2 })
      }
    }
    const pxScatter = makePixels({ width: PAGE_W, height: PAGE_H, bg: 255, rects: scatterRects })
    const diagS = emptyDiag()
    const boxesS = suggestWhiteoutCandidatesByField(
      [cell],
      { pages: [] },
      [],
      undefined,
      diagS,
      [pxScatter],
    )
    expect(boxesS.length, 'scattered small components → skip').toBe(0)
    expect(diagS.inkFiltered).toBe(1)

    // --- 大成分（記入）: ひとつながりの塊 → maxComponent 大 → 残す。
    const pxBlob = makePixels({
      width: PAGE_W,
      height: PAGE_H,
      bg: 255,
      rects: [{ x: 150, y: 230, w: 60, h: 40 }],
    })
    const diagB = emptyDiag()
    const boxesB = suggestWhiteoutCandidatesByField(
      [cell],
      { pages: [] },
      [],
      undefined,
      diagB,
      [pxBlob],
    )
    expect(boxesB.length, 'large component → painted').toBe(1)
    expect(diagB.inkFiltered).toBe(0)
  })

  it('🚨 K5: 背景色非依存総合。K2/K3 を白地・グレー地で同判定（地色の絶対値で変わらない）', () => {
    // K2 は本体ループで白/グレー両方を検証済。ここは K3（端列縦ラン除去 + 中央記入両立）を
    // 白地・グレー地で同一結果にする総合確認（前景幾何のみ・地色不使用を担保）。
    const cell: FieldBox = { page: 1, area: 'B', bbox: { x: 100, y: 200, w: 200, h: 80 } }
    // K3 と同じ「罫線際（最左/最右サンプル列を含む）縦フルラン」座標。
    const leftVLine = { x: 104, y: 204, w: 6, h: 72 }
    const rightVLine = { x: 290, y: 204, w: 6, h: 72 }

    for (const bg of [255, 210]) {
      // 端罫線のみ → 両地色とも skip。
      const pxRule = makePixels({
        width: PAGE_W,
        height: PAGE_H,
        bg,
        inkLuma: 30, // 背景より INK_LUMA_DELTA(60) 以上濃い（白でもグレーでも前景は同じ濃さ）
        rects: [leftVLine, rightVLine],
      })
      const dRule = emptyDiag()
      const bRule = suggestWhiteoutCandidatesByField([cell], { pages: [] }, [], undefined, dRule, [pxRule])
      expect(bRule.length, `bg=${bg} K3-edge-only → skip`).toBe(0)

      // 中央記入 + 端罫線 → 両地色とも painted。
      const pxMix = makePixels({
        width: PAGE_W,
        height: PAGE_H,
        bg,
        inkLuma: 30,
        rects: [leftVLine, rightVLine, { x: 180, y: 220, w: 60, h: 30 }],
      })
      const dMix = emptyDiag()
      const bMix = suggestWhiteoutCandidatesByField([cell], { pages: [] }, [], undefined, dMix, [pxMix])
      expect(bMix.length, `bg=${bg} K3-center+edge → painted`).toBe(1)
    }
  })
})
