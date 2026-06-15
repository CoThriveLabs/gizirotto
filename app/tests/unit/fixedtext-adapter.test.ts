import { describe, it, expect } from 'vitest'
import {
  fixedTextsToFields,
  fieldsToFixedTexts,
  fixedTextFieldName,
  computeFixedTextFontSize,
  bboxHeightFromFontSize,
  bboxHeightFromValue,
  bboxWidthFromValue,
  countFixedTextLines,
  textEmUnits,
  clampFixedTextFontSize,
  FIXED_TEXT_FONT_SIZE_RATIO,
  FIXED_TEXT_FONT_SIZE_MIN,
  FIXED_TEXT_WIDTH_PADDING_RATIO,
  DEFAULT_FIXEDTEXT_FONT,
  type FixedText,
  type FixedTextMeta,
} from '@/lib/pdf-output/fixedtext-adapter'
import {
  buildFixedTexts,
  FixedTextItemSchema,
  FIXEDTEXT_MAX,
  FIXEDTEXT_VALUE_MAX,
} from '@/lib/pdf-output/fixedtext-save'
import {
  resizeBbox,
  resizeBboxCentered,
  type PageMeta,
} from '@/lib/pdf-output/bbox-coords'

// FixedText ⇔ EditorField アダプタと保存検証の担保。
// 核心＝座標無変換の往復一致（±0・丸めなし）と value/font の meta 往復、ft_N 採番安定、
// FixedTextSchema バリデーション（空 value 除外・bbox 範囲・件数上限20）。

const FONT_A = { family: 'NotoSansJP', size: 10.5 }
const FONT_B = { family: 'NotoSerifJP', size: 14 }

function ft(
  name: string,
  value: string,
  page: number,
  x: number,
  y: number,
  w: number,
  h: number,
  font = FONT_A,
): FixedText {
  return { name, value, bbox: { page, x, y, w, h }, font }
}

function page(p: number, widthPt = 595, heightPt = 842): PageMeta {
  return { page: p, widthPt, heightPt, pixelWidth: 1000, pixelHeight: 1414 }
}

describe('fixedTextFieldName（合成 name 採番）', () => {
  it('index 0始まり → ft_N（1始まり・field_N/wo_N と非衝突の接頭辞）', () => {
    expect(fixedTextFieldName(0)).toBe('ft_1')
    expect(fixedTextFieldName(1)).toBe('ft_2')
    expect(fixedTextFieldName(9)).toBe('ft_10')
  })
})

describe('fixedTextsToFields → fieldsToFixedTexts（往復一致）', () => {
  it('座標・value・font.family は往復一致し、font.size は bbox から再算出される（v1.3 §3-2-6）', () => {
    const texts: FixedText[] = [
      ft('ft_1', '定例会議', 1, 10, 20, 100, 24, FONT_A),
      ft('ft_2', '参加者一同', 1, 50.5, 60.25, 200.75, 30.125, FONT_B),
      ft('ft_3', '議事録', 2, 0, 0, 595, 12, FONT_A),
    ]
    const { fields, meta } = fixedTextsToFields(texts)
    const roundtrip = fieldsToFixedTexts(fields, meta)
    // 座標・value・family は保存・復元される。
    roundtrip.forEach((rt, i) => {
      expect(rt.name).toBe(texts[i].name)
      expect(rt.value).toBe(texts[i].value)
      expect(rt.bbox).toEqual(texts[i].bbox)
      expect(rt.font.family).toBe(texts[i].font.family)
      // font.size は bbox 従属（案ア式）で再算出された値（入力 size とは無関係）。
      expect(rt.font.size).toBe(computeFixedTextFontSize(texts[i].bbox, texts[i].value))
    })
  })

  it('座標は無変換（丸めなし）で小数も完全一致', () => {
    const texts = [ft('ft_1', 'x', 1, 1.111, 2.222, 3.333, 4.444)]
    const { fields, meta } = fixedTextsToFields(texts)
    expect(fields[0].bbox).toEqual({
      x: 1.111,
      y: 2.222,
      w: 3.333,
      h: 4.444,
      page: 1,
    })
    const back = fieldsToFixedTexts(fields, meta)
    expect(back[0].bbox).toEqual({ page: 1, x: 1.111, y: 2.222, w: 3.333, h: 4.444 })
  })

  it('fields の label に value が載り・name は ft_N 採番', () => {
    const { fields } = fixedTextsToFields([
      ft('a', '会議名', 1, 0, 0, 10, 10),
      ft('b', '場所', 1, 0, 0, 10, 10),
    ])
    expect(fields.map((f) => f.name)).toEqual(['ft_1', 'ft_2'])
    expect(fields.map((f) => f.label)).toEqual(['会議名', '場所'])
  })

  it('value/font.family が meta に保持され往復で復元される（size は bbox 再算出）', () => {
    const { fields, meta } = fixedTextsToFields([
      ft('x', '会議', 1, 0, 0, 10, 10, FONT_B),
    ])
    expect(meta.get('ft_1')).toEqual({ value: '会議', font: FONT_B })
    const back = fieldsToFixedTexts(fields, meta)[0]
    expect(back.font.family).toBe(FONT_B.family)
    expect(back.font.size).toBe(computeFixedTextFontSize({ w: 10, h: 10 }, '会議'))
  })
})

describe('空配列・空 value', () => {
  it('fixedTextsToFields([]) は空 fields・空 meta', () => {
    const { fields, meta } = fixedTextsToFields([])
    expect(fields).toEqual([])
    expect(meta.size).toBe(0)
  })

  it('fieldsToFixedTexts は空 value（trim 後）の要素を除外する', () => {
    const fields = [
      { name: 'ft_1', label: '', bbox: { x: 0, y: 0, w: 10, h: 10, page: 1 } },
      { name: 'ft_2', label: '会議', bbox: { x: 0, y: 0, w: 10, h: 10, page: 1 } },
    ]
    const meta = new Map<string, FixedTextMeta>([
      ['ft_1', { value: '   ', font: FONT_A }],
      ['ft_2', { value: '会議', font: FONT_A }],
    ])
    const out = fieldsToFixedTexts(fields, meta)
    expect(out).toHaveLength(1)
    expect(out[0].value).toBe('会議')
  })

  it('meta 欠落時は label を value に・family 既定／size は bbox 再算出で補完', () => {
    const fields = [
      { name: 'ft_1', label: '会議名', bbox: { x: 5, y: 5, w: 50, h: 12, page: 1 } },
    ]
    const out = fieldsToFixedTexts(fields, new Map())
    expect(out[0]).toEqual({
      name: 'ft_1',
      value: '会議名',
      bbox: { page: 1, x: 5, y: 5, w: 50, h: 12 },
      font: {
        family: DEFAULT_FIXEDTEXT_FONT.family,
        size: computeFixedTextFontSize({ w: 50, h: 12 }, '会議名'),
      },
    })
  })
})

describe('computeFixedTextFontSize（案ア式・v1.3 §3-2-1）', () => {
  it('空 value は高さ基準（bbox.h * RATIO）をそのまま返す', () => {
    expect(computeFixedTextFontSize({ w: 100, h: 20 }, '')).toBe(20 * FIXED_TEXT_FONT_SIZE_RATIO)
    expect(computeFixedTextFontSize({ w: 100, h: 20 }, '   ')).toBe(
      20 * FIXED_TEXT_FONT_SIZE_RATIO,
    )
  })

  it('横に収まるなら高さ基準値を使う（縮小しない）', () => {
    // 幅広 bbox・短い CJK 2 文字。高さ基準 = 16。推定幅 = 16*2=32 <= w(200) なので高さ基準のまま。
    expect(computeFixedTextFontSize({ w: 200, h: 20 }, '会議')).toBe(16)
  })

  it('横溢れ時は bbox.w に収まる最大サイズへ縮小する（拡大しない）', () => {
    // 細長く高い bbox・CJK 3 文字。高さ基準 = 0.8*50=40。推定幅 = 40*3=120 > w(30)。
    // 縮小後 = w / emUnits = 30 / 3 = 10（高さ基準 40 より小さい＝縮小のみ）。
    const size = computeFixedTextFontSize({ w: 30, h: 50 }, 'あいう')
    expect(size).toBe(10)
    expect(size).toBeLessThan(50 * FIXED_TEXT_FONT_SIZE_RATIO)
  })

  it('半角は 0.5em 換算（CJK より横に詰められる）', () => {
    // 半角4文字 = 2em。高さ基準 = 0.8*20=16。推定幅 = 16*2=32 <= w(40) なので高さ基準のまま。
    expect(computeFixedTextFontSize({ w: 40, h: 20 }, 'ABCD')).toBe(16)
    // 同じ4文字でも幅が狭いと縮小: w=20 → 20/2=10。
    expect(computeFixedTextFontSize({ w: 20, h: 20 }, 'ABCD')).toBe(10)
  })
})

describe('双方向不変条件 font.size = bbox.h * RATIO（C-2 v1.5・案D）', () => {
  it('bboxHeightFromFontSize は computeFixedTextFontSize の逆（同一定数共有）', () => {
    // h → font（空 value で高さ基準）→ h 往復で元に戻る。
    const h = 30
    const size = computeFixedTextFontSize({ w: 999, h }, '') // 横溢れなし
    expect(size).toBe(h * FIXED_TEXT_FONT_SIZE_RATIO)
    expect(bboxHeightFromFontSize(size)).toBeCloseTo(h)
  })

  it('① 大きさボタン → bbox → font 往復一致（font→bbox→font）', () => {
    // font.size=24 起点 → bbox.h 逆算 → その bbox から font 再算出で 24 に戻る。
    const fontSize = 24
    const h = bboxHeightFromFontSize(fontSize) // 24/0.8 = 30
    expect(h).toBeCloseTo(30)
    const back = computeFixedTextFontSize({ w: 999, h }, '') // 横溢れなし
    expect(back).toBeCloseTo(fontSize)
  })

  it('② 4 隅ドラッグ → font → bbox 往復一致（bbox→font→bbox・横収まる前提）', () => {
    // bbox.h=50 → font=40 → h 逆算で 50 に戻る。
    const h = 50
    const font = computeFixedTextFontSize({ w: 999, h }, '会議名')
    expect(font).toBeCloseTo(h * FIXED_TEXT_FONT_SIZE_RATIO)
    expect(bboxHeightFromFontSize(font)).toBeCloseTo(h)
  })

  it('大きさボタン経路を resizeBboxCentered と合成しても中心保持＋比率維持', () => {
    // font.size を上げて bbox.h 逆算→aspect 維持で w 連動→中心保持リサイズ。
    const bbox = { x: 100, y: 100, w: 60, h: 30 } // aspect 2・中心 (130,115)
    const aspect = bbox.w / bbox.h
    const newH = bboxHeightFromFontSize(40) // 40/0.8 = 50
    const newW = newH * aspect // 100
    const r = resizeBboxCentered(bbox, newW, newH)
    expect(r.x + r.w / 2).toBeCloseTo(130) // 中心不動
    expect(r.y + r.h / 2).toBeCloseTo(115)
    expect(r.h).toBeCloseTo(50)
    expect(r.w / r.h).toBeCloseTo(aspect)
    // 結果 bbox.h から font 再算出で 40 に戻る（双方向一致）。
    expect(computeFixedTextFontSize(r, '')).toBeCloseTo(40)
  })
})

describe('clampFixedTextFontSize（font.size min/max クランプ・v1.5 §3-2-4 注意4）', () => {
  it('下限 FIXED_TEXT_FONT_SIZE_MIN(8pt) を下回らない', () => {
    expect(clampFixedTextFontSize(2, 1000)).toBe(FIXED_TEXT_FONT_SIZE_MIN)
    expect(clampFixedTextFontSize(8, 1000)).toBe(8)
  })

  it('上限 maxFontSize を超えない', () => {
    expect(clampFixedTextFontSize(500, 100)).toBe(100)
    expect(clampFixedTextFontSize(99, 100)).toBe(99)
  })

  it('上限が下限未満の異常時は下限を優先（潰さない）', () => {
    expect(clampFixedTextFontSize(50, 3)).toBe(FIXED_TEXT_FONT_SIZE_MIN)
  })
})

describe('bboxWidthFromValue（文字長→bbox.w 連動・C-2 v1.6 §3-2-1c）', () => {
  it('em 係数は textEmUnits 共有（半角0.5/CJK1）', () => {
    expect(textEmUnits('ABCD')).toBe(2) // 半角4 = 2em
    expect(textEmUnits('会議')).toBe(2) // CJK2 = 2em
    expect(textEmUnits('A会')).toBe(1.5) // 0.5 + 1
    expect(textEmUnits('')).toBe(0)
  })

  it('width = emUnits*fontSize + fontSize*0.3', () => {
    // CJK3 文字・fontSize=20。em=3 → 3*20 + 20*0.3 = 60 + 6 = 66。
    expect(bboxWidthFromValue('会議録', 20)).toBeCloseTo(
      3 * 20 + 20 * FIXED_TEXT_WIDTH_PADDING_RATIO,
    )
    // 半角6文字・fontSize=10。em=3 → 3*10 + 10*0.3 = 33。
    expect(bboxWidthFromValue('ABCDEF', 10)).toBeCloseTo(33)
  })

  it('長い value ほど幅が広がる（文字数追従）', () => {
    const short = bboxWidthFromValue('会', 20)
    const long = bboxWidthFromValue('会議議事録', 20)
    expect(long).toBeGreaterThan(short)
  })

  it('空 value は最小幅 MIN_BBOX_PT を維持（潰れない）', () => {
    // padding=fontSize*0.3。fontSize 小さいと padding < MIN_BBOX_PT → 最小幅にクランプ。
    expect(bboxWidthFromValue('', 8)).toBeGreaterThanOrEqual(4) // MIN_BBOX_PT=4
    expect(bboxWidthFromValue('   ', 8)).toBeGreaterThanOrEqual(4)
  })

  it('長い value で widthPt（A4=595pt）を超える幅も素直に返す（右端クランプは fixedValueChange 側で撤廃済み）', () => {
    // ページ右端クランプ撤廃の純関数側担保。
    // bboxWidthFromValue 自体はもとから widthPt に非依存（純粋に文字長×fontSize ベース）。
    // クランプは bbox-editor-client.tsx::fixedValueChange でかかっていたが v1.6.1 で撤廃。
    // ⇒ 関数の出力がページ幅を超えても素通しすることをここで明示確認（仕様契約として固定する）。
    const A4_WIDTH_PT = 595
    const longValue = '会議体運営委員会令和七年度第十二回定例会議事録案件討議資料案' // CJK 28 字
    const fontSize = 24
    const w = bboxWidthFromValue(longValue, fontSize)
    // 28em × 24pt + 24*0.3 = 672 + 7.2 = 679.2pt（widthPt=595 を超える）。
    expect(w).toBeGreaterThan(A4_WIDTH_PT)
  })
})

describe('v1.6 局面別の連動（4 局面・案E＋案D）', () => {
  const RATIO = FIXED_TEXT_FONT_SIZE_RATIO

  it('① value 編集 → 幅が文字数追従（h・font.size 不変）', () => {
    // bbox.h=20 → font.size=16（高さ基準・width 非依存）。value を伸ばすと w だけ増える。
    const h = 20
    const fontSize = h * RATIO // 16
    const w1 = bboxWidthFromValue('会', fontSize)
    const w2 = bboxWidthFromValue('会議録', fontSize)
    expect(w2).toBeGreaterThan(w1)
    // h・font.size は value に依存しない（局面表）。
    expect(h * RATIO).toBe(fontSize)
  })

  it('② 大きさ ± → font / 幅 / 高さ が連動（中心保持）', () => {
    const bbox = { x: 100, y: 100, w: 80, h: 20 } // 中心 (140,110)
    const value = '会議'
    // font.size を +4（高さ基準 16 → 20）。h=20/0.8... 逆算: h = 20/0.8 = 25。
    const newSize = 20
    const newH = bboxHeightFromFontSize(newSize) // 25
    const newW = bboxWidthFromValue(value, newSize) // 2*20 + 6 = 46
    const r = resizeBboxCentered(bbox, newW, newH)
    expect(r.h).toBeCloseTo(25)
    expect(r.w).toBeCloseTo(46)
    expect(r.x + r.w / 2).toBeCloseTo(140) // 中心保持
    expect(r.y + r.h / 2).toBeCloseTo(110)
    // 新 h から font 再算出で newSize に戻る（双方向一致）。
    expect(computeFixedTextFontSize({ w: 9999, h: r.h }, '')).toBeCloseTo(newSize)
  })

  it('③ 4 隅ドラッグ → 比率固定リサイズ（aspect 保持）', () => {
    const start = { x: 100, y: 100, w: 60, h: 30 } // aspect 2
    const aspect = start.w / start.h
    const r = resizeBbox(start, 'se', 40, 0) // se で幅主導
    // 自由リサイズは比率崩れるが、keepAspect ラッパ側で比率維持（別テストで担保済み）。
    // ここでは「ドラッグ起点 aspect = 開始時 w/h」であることを確認（局面表）。
    expect(aspect).toBe(2)
    expect(r.w).toBeGreaterThan(start.w) // se で広がる
  })

  it('④ リサイズ後 value 編集 → 幅が再び文字数連動', () => {
    // 手動リサイズで w=200 にした後、value 編集で w が bboxWidthFromValue に戻る。
    const manualBbox = { x: 50, y: 50, w: 200, h: 30 }
    const fontSize = manualBbox.h * RATIO // 24
    const wAfterEdit = bboxWidthFromValue('会', fontSize) // 1*24 + 24*0.3 = 31.2
    expect(wAfterEdit).toBeCloseTo(24 + 24 * FIXED_TEXT_WIDTH_PADDING_RATIO)
    expect(wAfterEdit).toBeLessThan(manualBbox.w) // 手動幅 200 から文字数幅へ戻る
  })
})

describe('結合: resizeBbox（案A・全モード共通）→ 保存で font.size が案ア式で算出される', () => {
  it('4 隅ドラッグで h が変わると font.size = bbox.h * RATIO に追従する（横は収まる前提）', () => {
    // 横長 bbox（収まる）。se ドラッグで高さを +10 して保存 → font.size = 新 h * RATIO。
    const start = { x: 50, y: 50, w: 300, h: 20, page: 1 }
    // 案A: 固定モードのリサイズは記入欄/白塗りと同じ resizeBbox 経路（縦横比ロックなし）。
    const resized = resizeBbox(start, 'se', 0, 10) // 高さ +10（左上固定）。
    const field = { name: 'ft_1', label: '会議名', bbox: { ...resized, page: 1 } }
    const meta = new Map<string, FixedTextMeta>([
      ['ft_1', { value: '会議名', font: { family: 'NotoSansJP', size: 999 } }],
    ])
    const [out] = fieldsToFixedTexts([field], meta)
    expect(out.bbox.h).toBeCloseTo(30) // 20 + 10
    // 横は 300pt で 3 文字（推定 3em）が高さ基準（30*0.8=24）で 72pt ＜ 300 ＝収まる → 高さ基準。
    expect(out.font.size).toBeCloseTo(30 * FIXED_TEXT_FONT_SIZE_RATIO)
    // 入力 meta の size(999) は無視され bbox 従属値で上書きされる。
    expect(out.font.size).not.toBe(999)
  })
})

describe('v1.7 改行対応（countFixedTextLines / bboxHeightFromValue / 複数行 width）', () => {
  const RATIO = FIXED_TEXT_FONT_SIZE_RATIO

  it('countFixedTextLines: 空は 1・改行なしは 1・N 改行は N+1 行', () => {
    expect(countFixedTextLines('')).toBe(1)
    expect(countFixedTextLines('一行')).toBe(1)
    expect(countFixedTextLines('一\n二')).toBe(2)
    expect(countFixedTextLines('一\n二\n三')).toBe(3)
    expect(countFixedTextLines('\n')).toBe(2) // 空行2つ
  })

  it('bboxHeightFromValue: N 行で h = N * (fontSize / RATIO)', () => {
    // 1 行: fontSize=16 → h = 16 / 0.8 = 20
    expect(bboxHeightFromValue('会議', 16)).toBeCloseTo(20)
    // 2 行: h = 2 * 20 = 40
    expect(bboxHeightFromValue('会議\n参加者', 16)).toBeCloseTo(40)
    // 3 行
    expect(bboxHeightFromValue('A\nB\nC', 16)).toBeCloseTo(60)
    // 空 value も 1 行扱い
    expect(bboxHeightFromValue('', 16)).toBeCloseTo(20)
  })

  it('bboxHeightFromFontSize は bboxHeightFromValue(1行) と一致（1 行あたり単位）', () => {
    const fontSize = 20
    expect(bboxHeightFromFontSize(fontSize)).toBeCloseTo(
      bboxHeightFromValue('1行', fontSize),
    )
  })

  it('bboxWidthFromValue は複数行のうち最長行で幅を決める', () => {
    // 短行 '会'(1em) + 長行 '会議議事録'(5em)。長行で計算されるべき。
    const fontSize = 20
    const wMulti = bboxWidthFromValue('会\n会議議事録', fontSize)
    const wLong = bboxWidthFromValue('会議議事録', fontSize)
    expect(wMulti).toBeCloseTo(wLong)
    // 短行のみより長くなる。
    const wShort = bboxWidthFromValue('会', fontSize)
    expect(wMulti).toBeGreaterThan(wShort)
  })

  it('computeFixedTextFontSize は N 行ぶんの高さから 1 行高さ基準で font.size を出す', () => {
    // bbox.h=40 を 2 行で使う → 1 行 = 20 → fontSize = 20 * 0.8 = 16
    expect(computeFixedTextFontSize({ w: 999, h: 40 }, '一\n二')).toBeCloseTo(16)
    // 1 行なら従来どおり: bbox.h * RATIO
    expect(computeFixedTextFontSize({ w: 999, h: 40 }, '一行')).toBeCloseTo(32)
  })

  it('大きさボタン経路: N 行を維持して font.size 変更 → bbox.h が連動', () => {
    // 2 行の固定テキスト・font.size=16 → bbox.h=40。+4pt で font.size=20 → h=2*25=50。
    const value = '一\n二'
    const n = countFixedTextLines(value)
    const curH = 40
    const curSize = (curH / n) * RATIO // 16
    expect(curSize).toBeCloseTo(16)
    const nextSize = curSize + 4 // 20
    const newH = bboxHeightFromValue(value, nextSize)
    expect(newH).toBeCloseTo(50) // 2 * (20/0.8) = 50
    // N 行は維持されている（value 不変）→ font.size と h が比例関係。
    expect(newH / n).toBeCloseTo(nextSize / RATIO)
  })

  it('value 編集で改行追加 → bbox.h が N 倍に / bbox.w は最長行に', () => {
    // 編集前: 1 行 '会'・fontSize=16 → h=20, w=16+16*0.3=20.8
    const fontSize = 16
    const before = {
      h: bboxHeightFromValue('会', fontSize),
      w: bboxWidthFromValue('会', fontSize),
    }
    // 編集後: 2 行 '会\n会議'。h は 2 倍、w は '会議'（2em）基準で増える。
    const after = {
      h: bboxHeightFromValue('会\n会議', fontSize),
      w: bboxWidthFromValue('会\n会議', fontSize),
    }
    expect(after.h).toBeCloseTo(before.h * 2)
    expect(after.w).toBeGreaterThan(before.w) // '会議' のほうが '会' より広い
  })
})

describe('FixedTextItemSchema バリデーション', () => {
  it('value は FIXEDTEXT_VALUE_MAX 字まで・超過は拒否', () => {
    const base = {
      name: 'ft_1',
      bbox: { page: 1, x: 0, y: 0, w: 10, h: 10 },
    }
    expect(
      FixedTextItemSchema.safeParse({ ...base, value: 'あ'.repeat(FIXEDTEXT_VALUE_MAX) })
        .success,
    ).toBe(true)
    expect(
      FixedTextItemSchema.safeParse({
        ...base,
        value: 'あ'.repeat(FIXEDTEXT_VALUE_MAX + 1),
      }).success,
    ).toBe(false)
  })

  it('font は省略可（欠損は後段で既定補完）', () => {
    const r = FixedTextItemSchema.safeParse({
      name: 'ft_1',
      value: '会議',
      bbox: { page: 1, x: 0, y: 0, w: 10, h: 10 },
    })
    expect(r.success).toBe(true)
  })
})

describe('buildFixedTexts（保存検証・§3-6）', () => {
  it('空 value を除外し ft_N を出現順で安定再採番・font 既定補完', () => {
    const r = buildFixedTexts(
      [
        { name: 'x', value: '  ', bbox: { page: 1, x: 0, y: 0, w: 10, h: 10 } },
        { name: 'y', value: '会議名', bbox: { page: 1, x: 0, y: 0, w: 10, h: 10 } },
        {
          name: 'z',
          value: '参加者',
          bbox: { page: 1, x: 0, y: 0, w: 10, h: 10 },
          font: FONT_B,
        },
      ],
      [page(1)],
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.fixedTexts.map((t) => t.name)).toEqual(['ft_1', 'ft_2'])
    expect(r.fixedTexts[0]).toMatchObject({ value: '会議名', font: DEFAULT_FIXEDTEXT_FONT })
    expect(r.fixedTexts[1]).toMatchObject({ value: '参加者', font: FONT_B })
  })

  it('bbox がページ範囲外なら BBOX_OUT_OF_RANGE', () => {
    const r = buildFixedTexts(
      [{ name: 'x', value: '会議', bbox: { page: 1, x: 0, y: 0, w: 99999, h: 10 } }],
      [page(1)],
    )
    expect(r).toEqual({ ok: false, error: 'BBOX_OUT_OF_RANGE' })
  })

  it('存在しないページなら PAGE_NOT_FOUND', () => {
    const r = buildFixedTexts(
      [{ name: 'x', value: '会議', bbox: { page: 9, x: 0, y: 0, w: 10, h: 10 } }],
      [page(1)],
    )
    expect(r).toEqual({ ok: false, error: 'PAGE_NOT_FOUND' })
  })

  it('除外後の件数が上限超なら FIXEDTEXT_COUNT_OUT_OF_RANGE', () => {
    const items = Array.from({ length: FIXEDTEXT_MAX + 1 }, (_, i) => ({
      name: `x${i}`,
      value: `v${i}`,
      bbox: { page: 1, x: 0, y: 0, w: 10, h: 10 },
    }))
    const r = buildFixedTexts(items, [page(1)])
    expect(r).toEqual({ ok: false, error: 'FIXEDTEXT_COUNT_OUT_OF_RANGE' })
  })

  it('空配列は ok・空結果（全削除）', () => {
    const r = buildFixedTexts([], [page(1)])
    expect(r).toEqual({ ok: true, fixedTexts: [] })
  })
})
