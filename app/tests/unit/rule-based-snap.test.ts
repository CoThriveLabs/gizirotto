import { describe, it, expect } from 'vitest'
import {
  snapFieldsToRuledCells,
  groupCellsIntoBands,
  identifyEntryCells,
  matchBandForField,
  splitByHorizontalGap,
  insetBox,
  computeAreaAEntryLeft,
  resolveAreaBEntryLeft,
  type Band,
} from '@/lib/pdf-output/rule-based-snap'
import {
  boundingBox,
  expandRightEdgeByPixels,
  expandBottomEdgeByPixels,
  probeAreaBEntryLeftByPixels,
  splitBandBByPixelHLines,
} from '@/lib/pdf-output/rule-based-snap-pixels'
import type { PageMeta, PagedBboxField } from '@/lib/pdf-output/bbox-coords'
import { type FieldBox, type RasterPagePixels } from '@/lib/parsers/pdf/field-bbox-detector'
import {
  BAND_GROUP_GAP_PT,
  BAND_RANGE_SPLIT_GAP_PT,
  POS_LABEL_MAX_W_RATIO,
  INSET_LEFT_PT,
  INSET_RIGHT_PT,
  INSET_TOP_PT,
  INSET_BOTTOM_PT,
} from '@/lib/parsers/pdf/whiteout-constants'

// A4 相当ページ（widthPt=595, heightPt=842）。labelMaxW = 595×0.22 ≈ 130.9。
const META: PageMeta = {
  page: 1,
  widthPt: 595,
  heightPt: 842,
  pixelWidth: 1190,
  pixelHeight: 1684,
}
const metaMap = new Map<number, PageMeta>([[1, META]])

function cell(
  x: number,
  y: number,
  w: number,
  h: number,
  area: 'A' | 'B' = 'A',
  page = 1,
): FieldBox {
  return { page, area, bbox: { x, y, w, h } }
}

function aiField(
  name: string,
  x: number,
  y: number,
  w: number,
  h: number,
  page = 1,
): PagedBboxField {
  return { name, bbox: { x, y, w, h, page } }
}

describe('rule-based-snap: ヘルパ純関数', () => {
  it('groupCellsIntoBands: y 近接（BAND_GROUP_GAP_PT 以内）で同一帯', () => {
    const cells = [
      cell(100, 100, 80, 20),
      cell(200, 100 + BAND_GROUP_GAP_PT, 80, 20), // 同一帯（gap ちょうど許容内）
      cell(100, 300, 80, 20), // 別帯
    ]
    const bands = groupCellsIntoBands(cells)
    expect(bands.length).toBe(2)
    expect(bands[0].cells.length).toBe(2)
    expect(bands[1].cells.length).toBe(1)
  })

  it('boundingBox: セル群の外接矩形（y/h は実セル基準＝大枠 h 採用）', () => {
    const cells = [cell(100, 200, 80, 30), cell(190, 205, 100, 25)]
    const b = boundingBox(cells)
    expect(b.x).toBe(100)
    expect(b.y).toBe(200) // min top
    expect(b.x + b.w).toBe(290) // max right
    expect(b.y + b.h).toBe(230) // max bottom（200+30 vs 205+25=230）
  })

  it('insetBox: 各辺を検出器 const 分だけ内側に縮める', () => {
    const b = { x: 100, y: 200, w: 300, h: 100 }
    const r = insetBox(b, META.widthPt, META.heightPt)
    expect(r.x).toBeCloseTo(100 + INSET_LEFT_PT)
    expect(r.y).toBeCloseTo(200 + INSET_TOP_PT)
    expect(r.w).toBeCloseTo(300 - INSET_LEFT_PT - INSET_RIGHT_PT)
    expect(r.h).toBeCloseTo(100 - INSET_TOP_PT - INSET_BOTTOM_PT)
  })

  it('insetBox: 極小セルでも w/h は最小 1pt（潰れ防止）', () => {
    const b = { x: 100, y: 200, w: 2, h: 2 }
    const r = insetBox(b, META.widthPt, META.heightPt)
    expect(r.w).toBeGreaterThanOrEqual(1)
    expect(r.h).toBeGreaterThanOrEqual(1)
  })
})

describe('B1 identifyEntryCells（記入欄特定・主因①全幅化解消）', () => {
  it('実値場所 cells=[w7,w10,w18,w366] → entry=[w366]（ラベル細セル複数除外）', () => {
    // labelMaxW ≈ 130.9。w7/10/18 は除外、w366 のみ残る＝記入欄 x65 w366 だけが range。
    const cells = [
      cell(30, 200, 7, 17),
      cell(37, 200, 10, 17),
      cell(47, 200, 18, 17),
      cell(65, 200, 366, 17),
    ]
    const entry = identifyEntryCells(cells, META.widthPt)
    expect(entry.length).toBe(1)
    expect(entry[0].bbox.w).toBe(366)
    expect(entry[0].bbox.x).toBe(65) // 左端 xL が 65 に直る（全幅化解消）
  })

  it('記入欄全滅ガード: 全部狭い帯は最大幅セル 1 つを残す', () => {
    const cells = [cell(30, 200, 7, 17), cell(37, 200, 18, 17), cell(56, 200, 10, 17)]
    const entry = identifyEntryCells(cells, META.widthPt)
    expect(entry.length).toBe(1)
    expect(entry[0].bbox.w).toBe(18) // 最大幅セル
  })

  it('1 セルはそのまま（除外しない）', () => {
    const cells = [cell(30, 200, 7, 17)]
    const entry = identifyEntryCells(cells, META.widthPt)
    expect(entry.length).toBe(1)
  })

  it('真の横並び（部署 w200 / 氏名 w150・両方 labelMaxW 超）は両方残る', () => {
    const cells = [cell(100, 100, 200, 20), cell(330, 100, 150, 20)]
    const entry = identifyEntryCells(cells, META.widthPt)
    expect(entry.length).toBe(2) // gap で後段 splitByHorizontalGap が別 range に割る
  })

  it('絶対閾値のみ（既定 USE_REL_LABEL_CUT=false）: labelMaxW 超は中幅でも残る', () => {
    // w140（>130.9）と w366。相対 OFF なので w140 も残る（最大幅 366×0.5=183 未満でも）。
    const cells = [cell(30, 100, 18, 20), cell(60, 100, 140, 20), cell(210, 100, 366, 20)]
    const entry = identifyEntryCells(cells, META.widthPt)
    // w18 除外、w140/w366 残る（既定 absolute のみ）。
    expect(entry.map((c) => c.bbox.w).sort((a, b) => a - b)).toEqual([140, 366])
  })
})

describe('B2 matchBandForField（area A/B マッチガード）', () => {
  const bandsByArea = () => ({
    A: groupCellsIntoBands([cell(65, 740, 300, 17, 'A')]), // 添付の area A 帯（y=740, h小）
    B: groupCellsIntoBands([cell(100, 680, 400, 60, 'B')]), // 決定事項の area B 大枠（y680-740）
  })

  it('small field（h=17）は area A 帯にマッチ（area B 大枠に吸着しない）', () => {
    const ai = { x: 65, y: 741, w: 300, h: 17 } // attachments（small）
    const m = matchBandForField(ai, bandsByArea())
    expect(m).not.toBeNull()
    expect(m!.area).toBe('A')
  })

  it('大枠 field（h=60）は area B 大枠にマッチ', () => {
    const ai = { x: 100, y: 685, w: 400, h: 60 } // decisions（大枠）
    const m = matchBandForField(ai, bandsByArea())
    expect(m).not.toBeNull()
    expect(m!.area).toBe('B')
  })

  it('small だが area A が無ければ area B 保険にフォールバック', () => {
    const onlyB = { A: [] as ReturnType<typeof groupCellsIntoBands>[number][], B: groupCellsIntoBands([cell(100, 100, 400, 60, 'B')]) }
    const ai = { x: 110, y: 110, w: 300, h: 17 }
    const m = matchBandForField(ai, onlyB)
    expect(m).not.toBeNull()
    expect(m!.area).toBe('B')
  })

  it('y 重なりゼロなら null（フォールバック）', () => {
    const ai = { x: 65, y: 50, w: 300, h: 17 } // どの帯とも y 重ならない
    const m = matchBandForField(ai, bandsByArea())
    expect(m).toBeNull()
  })
})

describe('splitByHorizontalGap（横並び分割）', () => {
  it('gap > SPLIT_GAP で別 range（部署｜氏名 分離）', () => {
    const deptRight = 250
    const nameLeft = deptRight + BAND_RANGE_SPLIT_GAP_PT + 10
    const cells = [cell(100, 100, deptRight - 100, 20), cell(nameLeft, 100, 150, 20)]
    const ranges = splitByHorizontalGap(cells, BAND_RANGE_SPLIT_GAP_PT)
    expect(ranges.length).toBe(2)
  })

  it('gap ≤ SPLIT_GAP は同一 range', () => {
    const cells = [cell(100, 100, 80, 20), cell(180 + 10, 100, 80, 20)]
    const ranges = splitByHorizontalGap(cells, BAND_RANGE_SPLIT_GAP_PT)
    expect(ranges.length).toBe(1)
  })
})

describe('snapFieldsToRuledCells 本体（v0.3）', () => {
  it('罫線なし（cells 空）→ AI bbox 維持（フォールバック・退行なし）', () => {
    const ai = [aiField('a', 50, 100, 400, 30)]
    const { fields, diag } = snapFieldsToRuledCells(ai, new Map(), metaMap)
    expect(fields[0].bbox).toEqual(ai[0].bbox)
    expect(diag[0]).toMatchObject({ source: 'ai-fallback', reason: 'no-ruled-cells' })
  })

  it('実値場所: ラベル細セル除外で xL=65・右端431(外枠)にスナップ（area A・small）', () => {
    // 帯 y=200 に [w7,w10,w18,w366]。記入欄 x65 w366（右端 65+366=431＝外枠）。
    const cells = new Map<number, FieldBox[]>([
      [
        1,
        [
          cell(30, 200, 7, 17, 'A'),
          cell(37, 200, 10, 17, 'A'),
          cell(47, 200, 18, 17, 'A'),
          cell(65, 200, 366, 17, 'A'),
        ],
      ],
    ])
    // AI は全幅気味（x30 w400）だが h=17（small）→ area A。
    const ai = [aiField('meeting_place', 30, 198, 400, 17)]
    const { fields, diag } = snapFieldsToRuledCells(ai, cells, metaMap)
    expect(diag[0]).toMatchObject({ source: 'ruled', reason: 'snapped', area: 'A' })
    // 左端 = 65 + inset、右端 = 431 - inset（外枠 431 に揃う・全幅化解消）。
    expect(fields[0].bbox.x).toBeCloseTo(65 + INSET_LEFT_PT)
    expect(fields[0].bbox.x + fields[0].bbox.w).toBeCloseTo(431 - INSET_RIGHT_PT)
  })

  it('大枠（area B）: 過大 h が罫線帯の実 h に是正（h 採用）', () => {
    const cells = new Map<number, FieldBox[]>([
      [1, [cell(100, 300, 400, 120, 'B')]],
    ])
    const ai = [aiField('gijiNaiyo', 90, 295, 420, 400)] // h=400（大枠）→ area B
    const { fields, diag } = snapFieldsToRuledCells(ai, cells, metaMap)
    expect(diag[0].area).toBe('B')
    expect(fields[0].bbox.h).toBeCloseTo(120 - INSET_TOP_PT - INSET_BOTTOM_PT)
    expect(fields[0].bbox.h).toBeLessThan(400)
  })

  it('attachments(small) が decisions の area B 大枠に吸着しない（area A へ）', () => {
    const cells = new Map<number, FieldBox[]>([
      [
        1,
        [
          cell(100, 680, 400, 60, 'B'), // decisions 大枠（y680-740）
          cell(65, 741, 300, 17, 'A'), // attachments 記入欄（area A・y=741）
        ],
      ],
    ])
    const ai = [aiField('attachments', 60, 740, 320, 17)] // small（h=17）
    const { fields, diag } = snapFieldsToRuledCells(ai, cells, metaMap)
    expect(diag[0].area).toBe('A') // 大枠に吸着せず area A へ
    expect(fields[0].bbox.h).toBeLessThan(60) // 大枠 h=60 でなく記入欄 h=17 ベース
  })

  it('帯はあるが y 重ならない → AI 維持（no-band）', () => {
    const cells = new Map<number, FieldBox[]>([[1, [cell(65, 200, 366, 17, 'A')]]])
    const ai = [aiField('far', 65, 700, 366, 17)]
    const { fields, diag } = snapFieldsToRuledCells(ai, cells, metaMap)
    expect(fields[0].bbox).toEqual(ai[0].bbox)
    expect(diag[0]).toMatchObject({ source: 'ai-fallback', reason: 'no-band' })
  })

  it('bbox 以外の属性は温存（label/type 等）', () => {
    const cells = new Map<number, FieldBox[]>([[1, [cell(65, 200, 366, 17, 'A')]]])
    const ai: PagedBboxField[] = [
      { name: 'f', label: '場所', type: 'text', bbox: { x: 60, y: 198, w: 370, h: 17, page: 1 } },
    ]
    const { fields } = snapFieldsToRuledCells(ai, cells, metaMap)
    expect(fields[0]['label']).toBe('場所')
    expect(fields[0]['type']).toBe('text')
  })

  it('入力 aiFields を破壊しない（新オブジェクトを返す）', () => {
    const cells = new Map<number, FieldBox[]>([[1, [cell(65, 200, 366, 17, 'A')]]])
    const ai = [aiField('f', 60, 198, 370, 17)]
    const before = JSON.stringify(ai)
    snapFieldsToRuledCells(ai, cells, metaMap)
    expect(JSON.stringify(ai)).toBe(before)
  })

  it('page メタ欠落 → AI 維持（no-page-meta）', () => {
    const cells = new Map<number, FieldBox[]>([[1, [cell(65, 200, 366, 17, 'A')]]])
    const ai = [aiField('x', 60, 198, 370, 17)]
    const { fields, diag } = snapFieldsToRuledCells(ai, cells, new Map())
    expect(fields[0].bbox).toEqual(ai[0].bbox)
    expect(diag[0].reason).toBe('no-page-meta')
  })
})

describe('const は検出器 import と同値（白塗りとブレない・死守）', () => {
  it('snap が使う検出器 const が期待値', () => {
    expect(BAND_GROUP_GAP_PT).toBe(2.0)
    expect(BAND_RANGE_SPLIT_GAP_PT).toBe(28)
    expect(POS_LABEL_MAX_W_RATIO).toBe(0.22)
    expect(INSET_LEFT_PT).toBe(3.0)
    expect(INSET_RIGHT_PT).toBe(3.0)
    expect(INSET_TOP_PT).toBe(3.0)
    expect(INSET_BOTTOM_PT).toBe(3.0)
  })
})

// =============================================================================
// P1.6b 本丸（NG1 右端拡張 / NG2-3 帯分割）。META は 595×842pt / 1190×1684px ＝ pxPerPt=2.0。
// 合成 RasterPagePixels に縦線/横線を黒(0,0,0)で描いて画素ロジックを検証する。
// =============================================================================

const DARK = 80 // BINARIZE_LUMA_THRESHOLD=160 未満＝暗画素
const LIGHT = 255

/** 全白の RasterPagePixels（META 解像度）。 */
function blankPixels(): RasterPagePixels {
  const w = META.pixelWidth
  const h = META.pixelHeight
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = LIGHT
    data[i + 1] = LIGHT
    data[i + 2] = LIGHT
    data[i + 3] = 255
  }
  return {
    page: 1,
    data,
    pixelWidth: w,
    pixelHeight: h,
    pageWidthPt: META.widthPt,
    pageHeightPt: META.heightPt,
  }
}

function setDark(px: RasterPagePixels, xPx: number, yPx: number): void {
  if (xPx < 0 || yPx < 0 || xPx >= px.pixelWidth || yPx >= px.pixelHeight) return
  const i = (yPx * px.pixelWidth + xPx) * 4
  px.data[i] = DARK
  px.data[i + 1] = DARK
  px.data[i + 2] = DARK
}

/** 縦線（x 固定・[y0Px,y1Px) 連続・幅 thick）。 */
function drawVLine(px: RasterPagePixels, xPx: number, y0Px: number, y1Px: number, thick = 2): void {
  for (let y = y0Px; y < y1Px; y++) {
    for (let t = 0; t < thick; t++) setDark(px, xPx + t, y)
  }
}

/** 横線（y 固定・[x0Px,x1Px) 連続・幅 thick）。 */
function drawHLine(px: RasterPagePixels, yPx: number, x0Px: number, x1Px: number, thick = 2): void {
  for (let x = x0Px; x < x1Px; x++) {
    for (let t = 0; t < thick; t++) setDark(px, x, yPx + t)
  }
}

const PT = (n: number) => Math.round(n * 2) // pxPerPt=2.0

describe('NG1 expandRightEdgeByPixels（右端拡張・553.5 想定）', () => {
  it('検出右端 431 の右にある真の外枠 553.5 まで右端だけ拡張（左/上/下不変）', () => {
    const px = blankPixels()
    // bounded: x65 y200 → 右端431, 帯 y200-217（h17）。真の外枠 553.5pt に強い縦線（帯全高）。
    const bounded = { x: 65, y: 200, w: 366, h: 17 }
    drawVLine(px, PT(553.5), PT(200), PT(217), 3)
    const out = expandRightEdgeByPixels(bounded, px)
    expect(out.x).toBe(65) // 左不変
    expect(out.y).toBe(200) // 上不変
    expect(out.h).toBe(17) // 下不変
    expect(out.x + out.w).toBeCloseTo(553.5, 0) // 右端が外枠へ拡張
  })

  it('右に強い縦線が無ければ bounded のまま（退行なし）', () => {
    const px = blankPixels() // 白紙
    const bounded = { x: 65, y: 200, w: 366, h: 17 }
    const out = expandRightEdgeByPixels(bounded, px)
    expect(out).toEqual(bounded)
  })

  it('帯ローカル: 他行（帯外）の縦線は拾わない', () => {
    const px = blankPixels()
    const bounded = { x: 65, y: 200, w: 366, h: 17 }
    // 縦線を帯の外（y400-450）にだけ描く → 帯 y200-217 では maxRun 不足で拾わない。
    drawVLine(px, PT(500), PT(400), PT(450), 3)
    const out = expandRightEdgeByPixels(bounded, px)
    expect(out).toEqual(bounded)
  })
})

describe('NG-A expandBottomEdgeByPixels（下端拡張・780 想定）', () => {
  it('検出下端 760 の下にある真の下外枠 780 まで下端だけ拡張（左/右/上不変）', () => {
    const px = blankPixels()
    // bounded: x100 y680 → 下端760（h80）。真の下外枠 780pt に強い横線（帯全幅）。
    const bounded = { x: 100, y: 680, w: 400, h: 80 }
    drawHLine(px, PT(780), PT(100), PT(500), 3)
    const out = expandBottomEdgeByPixels(bounded, px)
    expect(out.x).toBe(100) // 左不変
    expect(out.w).toBe(400) // 右不変
    expect(out.y).toBe(680) // 上不変
    // 下端が外枠 780 付近へ拡張（最深線追従なので 3px 太線の下端＝781pt 程度まで）。
    expect(out.y + out.h).toBeGreaterThanOrEqual(780)
    expect(out.y + out.h).toBeLessThanOrEqual(782)
  })

  it('下に強い横線が無ければ bounded のまま（退行なし）', () => {
    const px = blankPixels() // 白紙
    const bounded = { x: 100, y: 680, w: 400, h: 80 }
    const out = expandBottomEdgeByPixels(bounded, px)
    expect(out).toEqual(bounded)
  })

  it('帯ローカル: 他列（帯 x 範囲外）の横線は拾わない', () => {
    const px = blankPixels()
    const bounded = { x: 100, y: 680, w: 400, h: 80 }
    // 横線を帯の外（x10-60＝bounded x100-500 の外）にだけ描く → 帯幅で maxRun 不足で拾わない。
    drawHLine(px, PT(790), PT(10), PT(60), 3)
    const out = expandBottomEdgeByPixels(bounded, px)
    expect(out).toEqual(bounded)
  })

  it('最深線追従: 中間線(770)＋外枠(785)があれば最深(785)まで拡張（中間線は内部に残す）', () => {
    const px = blankPixels()
    const bounded = { x: 100, y: 680, w: 400, h: 80 } // 検出下端 760
    drawHLine(px, PT(770), PT(100), PT(500), 3) // 中間仕切り線
    drawHLine(px, PT(785), PT(100), PT(500), 3) // 真の外枠下端
    const out = expandBottomEdgeByPixels(bounded, px)
    // 770 で止まらず最深 785 付近まで拡張（中間 770 は後段 split が拾う）。
    expect(out.y + out.h).toBeGreaterThanOrEqual(785)
    expect(out.y + out.h).toBeLessThanOrEqual(787)
  })

  it('G1 白ギャップ打ち切り: 770 の先に大ギャップ後の線(810)があっても 770 で確定', () => {
    const px = blankPixels()
    const bounded = { x: 100, y: 680, w: 400, h: 80 } // 検出下端 760
    drawHLine(px, PT(770), PT(100), PT(500), 3) // 直近強線
    // 770→810 は 40pt 白ギャップ（BOTTOM_EXPAND_MAX_GAP_PT=16pt 超）→ 追従打ち切り。
    drawHLine(px, PT(810), PT(100), PT(500), 3)
    const out = expandBottomEdgeByPixels(bounded, px)
    expect(out.y + out.h).toBeGreaterThanOrEqual(770)
    expect(out.y + out.h).toBeLessThanOrEqual(772) // 810 まで暴走しない
  })

  it('G2 拡張量上限超え: 外枠が +40pt 超(810=+50pt)しか無ければ無拡張（退行ゼロ）', () => {
    const px = blankPixels()
    const bounded = { x: 100, y: 680, w: 400, h: 80 } // 検出下端 760
    // 760→810 = +50pt（BOTTOM_EXPAND_MAX_DELTA_PT=40 超）→ 探索打ち切り＝無拡張。
    drawHLine(px, PT(810), PT(100), PT(500), 3)
    const out = expandBottomEdgeByPixels(bounded, px)
    expect(out).toEqual(bounded)
  })

  it('G3 ページ下端クランプ: 下罫線が pageHeight 直前にあっても拡張後下端は pageHeightPt を超えない', () => {
    // G3 は「拡張後下端 > pageHeightPt なら無拡張」の防御ガード。pageHeightPt=842(=pixelHeight1684)。
    // ページ最下部 841pt 付近に強線を置く → 拡張しても下端は必ず pageHeightPt(842) 以内（はみ出さない）。
    const px = blankPixels()
    const bounded = { x: 100, y: 800, w: 400, h: 30 } // 検出下端 830（ページ最下部付近）
    drawHLine(px, PT(841), PT(100), PT(500), 3) // ページ下端ぎりぎりの強線
    const out = expandBottomEdgeByPixels(bounded, px)
    // 拡張しても下端は pageHeightPt(842) を超えない（G3／ピクセル境界の二重ガード）。
    expect(out.y + out.h).toBeLessThanOrEqual(META.heightPt)
    expect(out.y).toBe(800) // 上不変
    expect(out.x).toBe(100) // 左不変
  })

  it('G3 直接: 下罫線が pageHeightPt 超に写る不整合 px では無拡張（退行ゼロ）', () => {
    // pageHeightPt を実ピクセル高(1684)よりさらに小さく宣言し、強線 pt 換算が pageHeightPt を超える
    //   不整合ケースを作って G3 の `newBotPt > pageHeightPt` 分岐を直接踏む（防御ガードの単体検証）。
    const px = blankPixels()
    const inconsistent: RasterPagePixels = { ...px, pageHeightPt: 700 } // 実寸1684px のまま pageHeightPt だけ縮める
    // pyPerPt = 1684/700 ≈ 2.406。bounded 下端を 690pt（pageHeightPt700 直下）に置く。
    // その直下の強線は pt 換算で 700 超へ写る → newBotPt>pageHeightPt(700) で G3 無拡張。
    const yLinePx = Math.round(695 * (1684 / 700)) // ≈1673px（pt≈695 で 700 未満だが…）
    drawHLine(px, yLinePx, PT(100), PT(500), 3)
    const bounded = { x: 100, y: 660, w: 400, h: 30 } // 下端690pt
    const out = expandBottomEdgeByPixels(bounded, inconsistent)
    // 強線 pt 換算（yLinePx/pyPerPt ≈695〜696）が delta上限内かつ pageHeightPt(700)未満なら拡張、
    // 超なら G3 無拡張。いずれにせよ拡張後下端は pageHeightPt(700) を超えてはならない（G3 の保証）。
    expect(out.y + out.h).toBeLessThanOrEqual(700)
  })
})

describe('NG2/3 splitBandBByPixelHLines（最下部 area B 帯分割）', () => {
  it('decisions 大枠(y680-790) を 741/760/780 で 4 子帯に分割（area B 維持）', () => {
    const px = blankPixels()
    // area B 帯: x100 y680 w400 h110（680-790）。内部横罫線 741/760/780 を帯幅全体に描く。
    const band: Band = { cells: [cell(100, 680, 400, 110, 'B')] }
    for (const yPt of [741, 760, 780]) {
      drawHLine(px, PT(yPt), PT(100), PT(500), 3)
    }
    const children = splitBandBByPixelHLines(band, px)
    expect(children.length).toBe(4) // 680-741, 741-760, 760-780, 780-790
    for (const ch of children) {
      expect(ch.cells[0].area).toBe('B')
      expect(ch.cells[0].bbox.x).toBe(100) // x 範囲は親継承
      expect(ch.cells[0].bbox.w).toBe(400)
    }
    // 区切り y を概ね反映（先頭子帯は 680 始まり、2 番目は ~741 始まり）。
    expect(children[0].cells[0].bbox.y).toBeCloseTo(680, 0)
    expect(children[1].cells[0].bbox.y).toBeCloseTo(741, 0)
  })

  it('内部横罫線が無ければ分割しない（退行なし・帯そのまま）', () => {
    const px = blankPixels() // 横罫線なし
    const band: Band = { cells: [cell(100, 680, 400, 110, 'B')] }
    const children = splitBandBByPixelHLines(band, px)
    expect(children.length).toBe(1)
    expect(children[0]).toBe(band)
  })

  it('空帯はそのまま返す', () => {
    const px = blankPixels()
    const band: Band = { cells: [] }
    expect(splitBandBByPixelHLines(band, px)).toEqual([band])
  })
})

describe('snap 統合（pixels 経由・右端拡張＋帯分割）', () => {
  it('pixels ありで右端が外枠 553.5 まで拡張（area A small・左端 65 維持）', () => {
    const px = blankPixels()
    drawVLine(px, PT(553.5), PT(200), PT(217), 3)
    const cells = new Map<number, FieldBox[]>([
      [1, [cell(65, 200, 366, 17, 'A')]], // 検出右端 431
    ])
    const ai = [aiField('meeting_place', 30, 198, 400, 17)]
    const pixelsMap = new Map<number, RasterPagePixels>([[1, px]])
    const { fields, diag } = snapFieldsToRuledCells(ai, cells, metaMap, pixelsMap)
    expect(diag[0]).toMatchObject({ source: 'ruled', area: 'A' })
    expect(fields[0].bbox.x).toBeCloseTo(65 + INSET_LEFT_PT) // 左端維持
    // 右端 = 553.5 - inset（外枠まで拡張）。431 のままでない。
    expect(fields[0].bbox.x + fields[0].bbox.w).toBeCloseTo(553.5 - INSET_RIGHT_PT, 0)
  })

  it('pixels なしでは従来挙動（右端 431・退行なし）', () => {
    const cells = new Map<number, FieldBox[]>([
      [1, [cell(65, 200, 366, 17, 'A')]],
    ])
    const ai = [aiField('meeting_place', 30, 198, 400, 17)]
    const { fields } = snapFieldsToRuledCells(ai, cells, metaMap) // pixels 省略
    expect(fields[0].bbox.x + fields[0].bbox.w).toBeCloseTo(431 - INSET_RIGHT_PT)
  })

  it('帯分割で最下部 attachments(small) が分割後の自帯にマッチ（decisions 大枠に吸着しない）', () => {
    const px = blankPixels()
    // 横罫線 741 を引いて decisions(680-741) と attachments(741-790) に割る。
    drawHLine(px, PT(741), PT(100), PT(500), 3)
    const cells = new Map<number, FieldBox[]>([
      [
        1,
        [
          cell(100, 680, 400, 110, 'B'), // 検出器が帯化漏れした最下部大枠（680-790）
        ],
      ],
    ])
    const ai = [aiField('attachments', 110, 750, 380, 30)] // y750（分割後の下子帯 741-790 に入る）
    const pixelsMap = new Map<number, RasterPagePixels>([[1, px]])
    const { fields, diag } = snapFieldsToRuledCells(ai, cells, metaMap, pixelsMap)
    expect(diag[0].source).toBe('ruled')
    // 分割後の下子帯（741-790・h≈49）にマッチ → y は 741 以降・h は 110 でなく ~49 以下。
    expect(fields[0].bbox.y).toBeGreaterThanOrEqual(741)
    expect(fields[0].bbox.h).toBeLessThan(110)
  })

  it('NG-A: 検出器が切った最下部帯(680-760)を真の下罫線780まで拡張→760でnext_meetingが自帯を得る', () => {
    const px = blankPixels()
    // 検出器の最下部 area B 帯は y680-760 で切れている（next_meeting 行を含まない・帯下端に線なし）。
    // 画素: 内部横罫線 770（attachments|next_meeting 境界）／真の下外枠 785 を帯幅に描く。
    // 760 ちょうどには線を描かない（検出器が線の無い所で切った想定）→ 拡張は 785 まで届く。
    drawHLine(px, PT(770), PT(100), PT(500), 3) // 拡張後に内部分割線として拾われる
    drawHLine(px, PT(785), PT(100), PT(500), 3) // 真の下外枠（下端拡張のターゲット）
    const cells = new Map<number, FieldBox[]>([
      [1, [cell(100, 680, 400, 80, 'B')]], // 検出下端=760（next_meeting 770-790 が帯外）
    ])
    // next_meeting は下子帯（770-785・拡張＋split 後）にマッチさせる。
    const ai = [aiField('next_meeting', 110, 775, 380, 8)]
    const pixelsMap = new Map<number, RasterPagePixels>([[1, px]])
    const { fields, diag } = snapFieldsToRuledCells(ai, cells, metaMap, pixelsMap)
    expect(diag[0].source).toBe('ruled') // 自帯を得て ai-fallback でない
    // 拡張前 760 でなく、拡張＋split 後の下子帯（770-785）にスナップ → y は 770 近辺以降。
    expect(fields[0].bbox.y).toBeGreaterThanOrEqual(769)
    expect(fields[0].bbox.h).toBeLessThan(80) // 大枠 h=80 でなく子帯 h
  })

  it('NG-A: 下罫線が無ければ最下部帯は拡張されない（退行なし・従来パス）', () => {
    const px = blankPixels() // 横罫線なし
    const cells = new Map<number, FieldBox[]>([
      [1, [cell(100, 680, 400, 80, 'B')]],
    ])
    const ai = [aiField('decisions', 110, 700, 380, 40)]
    const pixelsMap = new Map<number, RasterPagePixels>([[1, px]])
    const { fields, diag } = snapFieldsToRuledCells(ai, cells, metaMap, pixelsMap)
    expect(diag[0].source).toBe('ruled')
    // 拡張なし＝下端 760 のまま（拡張後 h=80 を超えない）。
    expect(fields[0].bbox.y + fields[0].bbox.h).toBeLessThanOrEqual(760 - INSET_BOTTOM_PT + 0.5)
  })
})

// =============================================================================
// 左端被り再修正（案⑦主＝areaA記入欄左端の最頻値 ＋ 案⑥保険＝画素プローブ）。
// areaB 全幅1セルで右端y維持・左端だけ実測値へ（AI採用＝案⑤は寄せすぎ実機NGで廃止）。
// =============================================================================

describe('案⑦ computeAreaAEntryLeft（areaA記入欄左端の最頻値）', () => {
  it('複数 areaA 記入欄左端が x65 に揃う → mode=65・lefts に全件', () => {
    // 各帯はラベル細セル＋記入欄(x65 w366)。identifyEntryCells が記入欄だけ残す。
    const bandsA = [
      groupCellsIntoBands([cell(30, 100, 18, 17, 'A'), cell(65, 100, 366, 17, 'A')])[0],
      groupCellsIntoBands([cell(30, 130, 18, 17, 'A'), cell(65, 130, 366, 17, 'A')])[0],
    ]
    const r = computeAreaAEntryLeft(bandsA, META.widthPt)
    expect(r.mode).toBe(65)
    expect(r.lefts).toEqual([65, 65])
  })

  it('左端が微小に割れる（100/101）→ ビン化で 1 つに束ね、最頻ビンの最小値 100', () => {
    const bandsA = [
      groupCellsIntoBands([cell(100, 100, 366, 17, 'A')])[0],
      groupCellsIntoBands([cell(101, 130, 366, 17, 'A')])[0],
    ]
    const r = computeAreaAEntryLeft(bandsA, META.widthPt)
    // 100/101 は AREAA_LEFT_BIN_PT=4 で同ビン（round(x/4)=25）→ 最頻ビンの最小値 100。
    expect(r.mode).toBe(100)
  })

  it('最頻が割れる（100×1 / 200×1 同数）→ 最小ビンの値 100 を採る（過大採用回避）', () => {
    const bandsA = [
      groupCellsIntoBands([cell(100, 100, 366, 17, 'A')])[0],
      groupCellsIntoBands([cell(200, 130, 300, 17, 'A')])[0],
    ]
    const r = computeAreaAEntryLeft(bandsA, META.widthPt)
    expect(r.mode).toBe(100)
  })

  it('areaA 記入欄が無い → mode=null（案⑥保険へ）', () => {
    const r = computeAreaAEntryLeft([], META.widthPt)
    expect(r.mode).toBeNull()
    expect(r.lefts).toEqual([])
  })
})

describe('案⑥ probeAreaBEntryLeftByPixels（画素ラベル右端＝記入欄左端）', () => {
  // expanded 帯 x50 y740 w480 h30。外枠 x50 に縦罫線、ラベル文字塊 x84-110、その後空白。
  const expandedBox = () => ({ x: 50, y: 740, w: 480, h: 30 })

  it('外枠縦罫線(x50)を弾き、ラベル塊(x84-110)右端の空白開始x≈110 を返す', () => {
    const px = blankPixels()
    // 外枠縦罫線（帯全高＝縦ラン比1.0・PIXEL_PROBE_VLINE_RATIO 超でスキップされる）。
    drawVLine(px, PT(50), PT(740), PT(770), 3)
    // ラベル文字塊: x84-110 を帯高の約半分だけ暗くする（縦ラン比は外枠未満・暗画素比は閾値超）。
    for (let xPt = 84; xPt < 110; xPt++) {
      drawHLine(px, PT(755), PT(xPt), PT(xPt + 1), 8) // 各列に 8px 厚の暗 ≒ 暗画素比 8/60≈0.13>0.06
    }
    const probed = probeAreaBEntryLeftByPixels(expandedBox(), px)
    expect(probed).not.toBeNull()
    // ラベル塊 x110 直後の空白開始＝記入欄左端候補（±数px）。
    expect(probed!).toBeGreaterThanOrEqual(108)
    expect(probed!).toBeLessThanOrEqual(114)
  })

  it('全列空白（ラベル塊なし・薄文字）→ null（フォールバック）', () => {
    const px = blankPixels() // 真っ白
    expect(probeAreaBEntryLeftByPixels(expandedBox(), px)).toBeNull()
  })
})

describe('resolveAreaBEntryLeft（案⑦主＋案⑥保険・発火ガード）', () => {
  const fullWidthRange = (): FieldBox[] => [cell(65, 740, 485.5, 30, 'B')]
  const expandedBox = () => ({ x: 65, y: 740, w: 485.5, h: 30 }) // 右端 550.5
  const aaWith = (mode: number | null): ReturnType<typeof computeAreaAEntryLeft> => ({
    lefts: mode === null ? [] : [mode],
    mode,
  })

  it('案⑦: areaA左端=罫線左端と同値(65) → 縮小方向ガードで非発火・expanded 不変', () => {
    // 候補 65 が expanded.x(65) と同値 → 縮小方向のみガードで採用しない（はみ出し/無変化を避ける）。
    const r = resolveAreaBEntryLeft(expandedBox(), fullWidthRange(), 'B', aaWith(65))
    expect(r.box).toEqual(expandedBox())
    expect(r.source).toBe('fallback-kept')
  })

  it('案⑦: areaA左端が罫線左端より右(x90) → 左端90採用・右端維持', () => {
    // expanded 左端65 より右の実測値だけ採用（縮小方向のみ）。
    const r = resolveAreaBEntryLeft(expandedBox(), fullWidthRange(), 'B', aaWith(90))
    expect(r.source).toBe('areaA-borrow')
    expect(r.box.x).toBe(90)
    expect(r.box.x + r.box.w).toBeCloseTo(550.5) // 右端維持
    expect(r.box.y).toBe(740) // y 維持
  })

  it('areaA(location相当・matchedArea=A) → 非発火・expanded 不変・source=fallback-kept', () => {
    const r = resolveAreaBEntryLeft(expandedBox(), fullWidthRange(), 'A', aaWith(90))
    expect(r.box).toEqual(expandedBox())
    expect(r.source).toBe('fallback-kept')
  })

  it('横並び range.length=2 → 非発火・従来パス', () => {
    const range = [cell(65, 740, 200, 30, 'B'), cell(330, 740, 150, 30, 'B')]
    const r = resolveAreaBEntryLeft(expandedBox(), range, 'B', aaWith(90))
    expect(r.box).toEqual(expandedBox())
    expect(r.source).toBe('fallback-kept')
  })

  it('案⑦不可(mode=null)＋px なし → expanded 維持（フォールバック）', () => {
    const r = resolveAreaBEntryLeft(expandedBox(), fullWidthRange(), 'B', aaWith(null))
    expect(r.box).toEqual(expandedBox())
    expect(r.source).toBe('fallback-kept')
  })

  it('過剰縮小ガード: 候補xが右端に近すぎ(幅<MIN_W) → 非発火', () => {
    const r = resolveAreaBEntryLeft(expandedBox(), fullWidthRange(), 'B', aaWith(545))
    expect(r.box).toEqual(expandedBox())
    expect(r.source).toBe('fallback-kept')
  })
})

describe('snap 統合: 左端被り再修正（案⑦ areaA borrow）', () => {
  it('areaB全幅1セル attachments の左端が同ページ areaA(左端65→寄せ先90相当) へ・右端維持', () => {
    // areaA 記入欄左端 x90（細ラベル除外後）。areaB 大枠 x65 w485.5（右端550.5・左端65）。
    // 案⑦で左端を areaA 最頻値 90 へ寄せる（65→90）。pixels なし＝右端拡張なし。
    const cells = new Map<number, FieldBox[]>([
      [
        1,
        [
          cell(40, 100, 20, 17, 'A'), // ラベル細セル（除外される）
          cell(90, 100, 340, 17, 'A'), // areaA 記入欄（左端90）
          cell(65, 740, 485.5, 30, 'B'), // attachments の areaB 全幅大枠
        ],
      ],
    ])
    const ai = [aiField('attachments', 300, 745, 200, 20)] // AI は当てにしない（案⑤廃止）
    const { fields, diag } = snapFieldsToRuledCells(ai, cells, metaMap)
    const att = fields.find((f) => f['name'] === 'attachments')!
    expect(diag.find((d) => d.name === 'attachments')).toMatchObject({ source: 'ruled', area: 'B' })
    // 左端 = 90 + inset（areaA borrow・AI の 300 ではない）、右端 = 550.5 - inset。
    expect(att.bbox.x).toBeCloseTo(90 + INSET_LEFT_PT)
    expect(att.bbox.x + att.bbox.w).toBeCloseTo(550.5 - INSET_RIGHT_PT)
  })

  it('areaA(location) は従来どおり罫線左端（案⑦非発火・areaA経路）', () => {
    const cells = new Map<number, FieldBox[]>([
      [1, [cell(40, 200, 20, 17, 'A'), cell(65, 200, 366, 17, 'A')]],
    ])
    const ai = [aiField('location', 30, 198, 400, 17)] // small → areaA
    const { fields, diag } = snapFieldsToRuledCells(ai, cells, metaMap)
    expect(diag[0].area).toBe('A')
    expect(fields[0].bbox.x).toBeCloseTo(65 + INSET_LEFT_PT) // 罫線左端 65 のまま
  })
})
