/**
 * computeUniformFontSize unit test
 *
 * 純粋関数 + fake font 注入で「記入欄統一サイズ」算出の論理を検証する:
 *   - 通常欄のみ        → min sizeByHeight を clamp した uniform
 *   - 極小欄混在        → 外れ値除外撤廃。最小欄（極小欄含む）基準で全項目同一
 *   - 全欄極小          → base が RANGE_MIN を割っても clamp で RANGE_MIN
 *   - レンジ境界        → base<MIN / base>MAX でクランプ
 *   - lineHeightRatio   → LINE_HEIGHT_RATIO(=1.0) 固定・font 非依存
 *   - sizeByHeight      → 既定 pad=0pt / 上書き padding 反映 / usableH<=0 で 0
 *
 * LINE_HEIGHT_RATIO が 1.0 固定のため fake font の R は uniform 算出には効かない
 * （lineHeightRatio は font 非依存）。R は FittableFont を満たすためのダミーとして残す。
 */
import { describe, it, expect } from 'vitest'
import {
  computeUniformFontSize,
  sizeByHeight,
  lineHeightRatio,
  snapToFixedText,
  RANGE_MIN,
  RANGE_MAX,
  LINE_HEIGHT_RATIO,
  UNIFORM_PAD_TOP,
  UNIFORM_PAD_BOTTOM,
  FIXED_TEXT_SNAP_THRESHOLD_PT,
  FIXED_TEXT_BODY_BAND_MIN_PT,
  FIXED_TEXT_BODY_BAND_MAX_PT,
  type UniformSizeField,
} from '@/lib/pdf-output/uniform-size'
import type { FittableFont } from '@/lib/pdf-output/fitting'
import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'

/**
 * heightAtSize(size) = size * R の最小スタブ。
 * LINE_HEIGHT_RATIO が固定 1.0 になったため uniform 算出では R は使われない
 * （font 非依存）。FittableFont を満たすためだけに与える。
 */
function makeFont(R = 1): FittableFont {
  return {
    widthOfTextAtSize: (text, size) => text.length * size * 0.5,
    heightAtSize: (size) => size * R,
  }
}

/**
 * 記入欄 field を作る。padding は uniform 既定（UNIFORM_PAD_TOP/BOTTOM=0pt）が使われるため、
 * field.padding はここでは sizeByHeight に影響しない（明示 padding 引数を渡したときのみ反映）。
 * sizeByHeight(f) = (h - 0 - 0) / 1.0 = h。
 */
function makeField(h: number, name = 'f'): UniformSizeField & { name: string } {
  return {
    name,
    bbox: { h },
    padding: { left: 4, top: 4, right: 4, bottom: 4 },
  }
}

describe('定数', () => {
  it('RANGE_MIN=9 / RANGE_MAX=18 / LINE_HEIGHT_RATIO=1.0 / pad=0', () => {
    expect(RANGE_MIN).toBe(9)
    expect(RANGE_MAX).toBe(18)
    expect(LINE_HEIGHT_RATIO).toBe(1.0)
    expect(UNIFORM_PAD_TOP).toBe(0)
    expect(UNIFORM_PAD_BOTTOM).toBe(0)
  })
})

describe('lineHeightRatio', () => {
  it('LINE_HEIGHT_RATIO(=1.0) を font 非依存で返す', () => {
    expect(lineHeightRatio(makeFont(1))).toBe(1.0)
    // font の heightAtSize がどんな係数でも結果は 1.0（R 固定・旧 heightAtSize 由来を撤廃）。
    expect(lineHeightRatio(makeFont(1.448))).toBe(1.0)
    expect(lineHeightRatio()).toBe(1.0)
  })
})

describe('sizeByHeight', () => {
  it('既定 pad=0pt で (h - 0 - 0) / ratio を返す', () => {
    // h=28, 既定 pad 0+0=0 → usableH=28、ratio=1 → 28
    expect(sizeByHeight(makeField(28), 1)).toBe(28)
    // ratio=2 → 14
    expect(sizeByHeight(makeField(28), 2)).toBe(14)
  })

  it('padding 上書き引数が既定 pad より優先される', () => {
    // h=28, 上書き pad top=10/bottom=10 → usableH=8、ratio=1 → 8
    const f = makeField(28)
    expect(sizeByHeight(f, 1, { left: 0, top: 10, right: 0, bottom: 10 })).toBe(8)
  })

  it('利用可能高さが 0 以下なら 0 を返す', () => {
    // pad=0 なので usableH<=0 は h<=0 のときのみ。h=0 → usableH=0
    expect(sizeByHeight(makeField(0), 1)).toBe(0)
    // 上書き padding で usableH を 0 以下にしても 0（h=10, pad top=6/bottom=4 → usableH=0）
    expect(
      sizeByHeight(makeField(10), 1, { left: 0, top: 6, right: 0, bottom: 4 }),
    ).toBe(0)
    // h=10, 上書き pad top=8/bottom=4 → usableH=-2 → 0
    expect(
      sizeByHeight(makeField(10), 1, { left: 0, top: 8, right: 0, bottom: 4 }),
    ).toBe(0)
  })
})

describe('computeUniformFontSize - 通常欄のみ', () => {
  it('min sizeByHeight を clamp した uniform を返す（レンジ内）', () => {
    // ratio=1.0、pad=0。usableH = h。
    //   f1: h=28 → 28、f2: h=13 → 13、f3: h=22 → 22
    // 母集団は全て >= RANGE_MIN(9)。min = 13 → clamp(13,9,18)=13。
    const fields = [makeField(28, 'a'), makeField(13, 'b'), makeField(22, 'c')]
    expect(computeUniformFontSize(fields, makeFont(1))).toBe(13)
  })

  it('全欄が大きい場合は最小欄の高さいっぱいでも RANGE_MAX でクランプ', () => {
    // f1: h=28 → 28、f2: h=27 → 27。min=27 だが RANGE_MAX=18 でクランプ。
    const fields = [makeField(28, 'a'), makeField(27, 'b')]
    expect(computeUniformFontSize(fields, makeFont(1))).toBe(RANGE_MAX)
  })
})

describe('computeUniformFontSize - 最小欄基準（外れ値除外撤廃）', () => {
  it('縦幅最小の欄を base に取り全項目を同一サイズへ揃える', () => {
    // 議題(短文,大欄): f1 h=22 → 22、議事内容(長文,大欄): f2 h=19 → 19
    // 日時/場所(縦幅最小): f3 h=10 → 10（旧実装では除外されていた欄）
    // 撤廃後は f3 が母集団に残り base = min(22,19,10)=10 → clamp(10,9,18)=10。
    // 全項目がこの 10pt 同一に統一される（大欄も最小欄基準で小さく表示）。
    const fields = [
      makeField(22, 'agenda'),
      makeField(19, 'content'),
      makeField(10, 'datetime'),
    ]
    expect(computeUniformFontSize(fields, makeFont(1))).toBe(10)
  })

  it('全欄がレンジ内なら最小欄の sizeByHeight がそのまま uniform になる', () => {
    // f1 h=28 → 28、f2 h=16 → 16（最小）、f3 h=22 → 22。
    // base = min = 16 → clamp(16,9,18)=16。最小欄基準で全項目 16pt。
    const fields = [makeField(28, 'a'), makeField(16, 'b'), makeField(22, 'c')]
    expect(computeUniformFontSize(fields, makeFont(1))).toBe(16)
  })

  it('場所 h=16 基準で uniform=16pt（最小欄・代表ケース）', () => {
    // 場所 bbox.h=16。pad=0 なので sizeByHeight = (16-0-0)/1.0 = 16。
    // 大欄混在でも min=16 が base → clamp(16,9,18)=16（RANGE_MAX=18 でクランプされない）。
    const fields = [
      makeField(16, 'place'),
      makeField(52, 'agenda'),
      makeField(342, 'content'),
    ]
    expect(computeUniformFontSize(fields, makeFont(1))).toBe(16)
  })

  it('境界 sizeByHeight === RANGE_MIN の欄が最小なら uniform=RANGE_MIN', () => {
    // pad=0 なので f1 h=9 → 9（== RANGE_MIN・最小）、f2 h=22 → 22。
    // base = min = 9 → clamp(9,9,18)=9。
    const fields = [makeField(9, 'edge'), makeField(22, 'big')]
    expect(computeUniformFontSize(fields, makeFont(1))).toBe(9)
  })
})

describe('computeUniformFontSize - 全欄極小 → RANGE_MIN クランプ', () => {
  it('全欄 sizeByHeight < RANGE_MIN でも clamp 下限 RANGE_MIN に揃う', () => {
    // pad=0。f1 h=8 → 8、f2 h=5 → 5。base = min = 5 → clamp(5,9,18)=9。
    const fields = [makeField(8, 'tiny1'), makeField(5, 'tiny2')]
    expect(computeUniformFontSize(fields, makeFont(1))).toBe(RANGE_MIN)
  })

  it('fields が空配列なら RANGE_MIN を返す', () => {
    expect(computeUniformFontSize([], makeFont(1))).toBe(RANGE_MIN)
  })
})

describe('computeUniformFontSize - レンジ境界クランプ', () => {
  it('base < MIN（最小欄が極小）は MIN にクランプ', () => {
    // base が MIN 未満になっても clamp 下限で出力は MIN。
    const fields = [makeField(7, 'x')] // pad=0 → usableH=7 → base=7 → clamp(7,9,18)=9
    expect(computeUniformFontSize(fields, makeFont(1))).toBe(RANGE_MIN)
  })

  it('base > MAX は MAX にクランプ', () => {
    // pad=0。f h=58 → usableH=58 → base=58 → clamp(58,9,18)=18。
    const fields = [makeField(58, 'huge')]
    expect(computeUniformFontSize(fields, makeFont(1))).toBe(RANGE_MAX)
  })

  it('カスタムレンジ {min,max} でクランプが効く', () => {
    // pad=0。f h=28 → usableH=28、ratio=1 → base=28。range max=16 → clamp(28,9,16)=16。
    const fields = [makeField(28, 'a')]
    expect(
      computeUniformFontSize(fields, makeFont(1), undefined, { min: 9, max: 16 }),
    ).toBe(16)
    // min を 30 に上げると base=28 < min=30 → clamp(28,30,40)=30（下限へ引き上げ）。
    expect(
      computeUniformFontSize(fields, makeFont(1), undefined, { min: 30, max: 40 }),
    ).toBe(30)
  })
})

describe('computeUniformFontSize - ratio は LINE_HEIGHT_RATIO(1.0) 固定・font 非依存', () => {
  it('font の heightAtSize 係数が変わっても uniform は不変（R は font に依存しない）', () => {
    // R=1.0 固定、pad=0。f h=28 → usableH=28 → sizeByHeight=28/1.0=28 → clamp(28,9,18)=18。
    // makeFont(2)（heightAtSize=2*size）でも uniform は同じ 18（旧実装は font 依存で 13 だった）。
    const fields = [makeField(28, 'a')]
    expect(computeUniformFontSize(fields, makeFont(1))).toBe(RANGE_MAX)
    expect(computeUniformFontSize(fields, makeFont(2))).toBe(RANGE_MAX)
  })
})

describe('computeUniformFontSize - padding 上書き（field name → padding）', () => {
  it('PdfField に name があれば padding map で上書きされる', () => {
    // PdfField 相当（name あり）。padding map で top/bottom を増やし usableH を縮める。
    const field: PdfField = {
      name: 'a',
      label: 'A',
      type: 'text',
      bbox: { page: 1, x: 0, y: 0, w: 100, h: 28 },
      max_chars: 40,
      font: { family: 'Noto Sans JP', size: 10.5 },
      padding: { left: 4, top: 4, right: 4, bottom: 4 },
      multiline: false,
      align: 'left',
      vertical: 'top',
      writing_mode: 'horizontal',
      overflow_strategy: 'shrink_then_wrap',
      font_size_min: 8,
    }
    // 既定 uniform pad(0+0): usableH = 28-0 = 28 → base=28 → clamp=18。
    expect(computeUniformFontSize([field], makeFont(1))).toBe(RANGE_MAX)
    // 上書き padding top=10/bottom=8 → usableH=10 → base=10 → clamp(10,9,18)=10。
    expect(
      computeUniformFontSize([field], makeFont(1), {
        a: { left: 0, top: 10, right: 0, bottom: 8 },
      }),
    ).toBe(10)
  })
})

/**
 * snapToFixedText: 固定テキストサイズへの snap 純関数 / 結合テスト。
 *
 * - 閾値 = ±1.0pt（FIXED_TEXT_SNAP_THRESHOLD_PT）
 * - 選択基準 = 最頻値（mode）。同点時は大きい方
 * - 外れ値除外帯 = 9-14pt（本文サイズ帯）。タイトル等は除外
 * - 母集団 0 件 / 閾値外 → raw 維持（後方互換）
 */
describe('定数（snapToFixedText）', () => {
  it('FIXED_TEXT_SNAP_THRESHOLD_PT=1.0 / body band=9-14pt', () => {
    expect(FIXED_TEXT_SNAP_THRESHOLD_PT).toBe(1.0)
    expect(FIXED_TEXT_BODY_BAND_MIN_PT).toBe(9)
    expect(FIXED_TEXT_BODY_BAND_MAX_PT).toBe(14)
  })
})

describe('snapToFixedText - 閾値内 1 件で snap', () => {
  it('rawPt=12.3, fixed=[12] → 差 0.3pt <= 1.0pt で 12 にスナップ', () => {
    expect(snapToFixedText(12.3, [12])).toBe(12)
  })
  it('rawPt=10.0, fixed=[10.5] → 差 0.5pt で 10.5 にスナップ', () => {
    expect(snapToFixedText(10.0, [10.5])).toBe(10.5)
  })
  it('閾値の境界（ちょうど 1.0pt 差）でも snap する', () => {
    // |11 - 12| = 1.0 <= 1.0
    expect(snapToFixedText(11.0, [12])).toBe(12)
  })
})

describe('snapToFixedText - 複数候補で最頻値を選ぶ', () => {
  it('mode が一意ならその値へ snap（rawPt との距離は問わない・閾値内であれば）', () => {
    // 母集団: [10, 10, 10, 12]（10 が最頻）。raw=10.5 → mode=10 にスナップ（差 0.5）。
    expect(snapToFixedText(10.5, [10, 10, 10, 12])).toBe(10)
  })
  it('mode と raw の差が閾値超なら raw を返す（mode が「近いが届かない」）', () => {
    // 母集団: [10, 10, 12]（mode=10）。raw=11.5 → |10-11.5|=1.5 > 1.0 で snap せず。
    expect(snapToFixedText(11.5, [10, 10, 12])).toBe(11.5)
  })
})

describe('snapToFixedText - 同点時は大きい方', () => {
  it('mode 同点（10 と 12 が同数）→ 大きい方 12 を mode に採用', () => {
    // [10, 10, 12, 12]。raw=12.3 → mode=12 にスナップ（差 0.3 <= 1.0）。
    expect(snapToFixedText(12.3, [10, 10, 12, 12])).toBe(12)
  })
  it('同点時の大きい方が raw から閾値外なら snap しない', () => {
    // [10, 10, 12, 12]。raw=10.4 → mode=12（同点時大きい方）→ |12-10.4|=1.6 > 1.0 で raw 維持。
    expect(snapToFixedText(10.4, [10, 10, 12, 12])).toBe(10.4)
  })
})

describe('snapToFixedText - 閾値外で raw 維持', () => {
  it('|mode - raw| > 1.0pt なら raw を返す', () => {
    expect(snapToFixedText(14.0, [10])).toBe(14.0)
    expect(snapToFixedText(9.5, [11])).toBe(9.5)
  })
  it('カスタム閾値（0.5pt）でも判定が効く', () => {
    expect(snapToFixedText(10.4, [10], 0.5)).toBe(10)
    expect(snapToFixedText(10.6, [10], 0.5)).toBe(10.6)
  })
})

describe('snapToFixedText - 0 件で raw 維持（後方互換）', () => {
  it('fixedTextSizesPt が空配列なら raw 返却', () => {
    expect(snapToFixedText(12.3, [])).toBe(12.3)
  })
  it('配列でない（防御）→ raw 返却', () => {
    // 型上は number[] だが、ランタイムで undefined を渡された場合の防御を確認。
    expect(snapToFixedText(12.3, undefined as unknown as number[])).toBe(12.3)
  })
})

describe('snapToFixedText - 外れ値除外（タイトル等）', () => {
  it('タイトル 20pt は body band(9-14pt) から外れて除外され、本文 10pt にスナップ', () => {
    // [20, 10, 10]: 20 は除外。残り [10, 10] → mode=10。raw=10.4 → snap して 10。
    expect(snapToFixedText(10.4, [20, 10, 10])).toBe(10)
  })
  it('全要素が外れ値なら raw 維持', () => {
    // [20, 30] は両方除外（>14pt） → 候補ゼロ → raw 返却。
    expect(snapToFixedText(12.3, [20, 30])).toBe(12.3)
  })
  it('band 境界値（9pt と 14pt）は母集団に含まれる', () => {
    expect(snapToFixedText(9.3, [9, 9, 14])).toBe(9)
    expect(snapToFixedText(13.8, [14, 14, 9])).toBe(14)
  })
  it('NaN / Infinity / 非数値は除外される', () => {
    expect(
      snapToFixedText(10.4, [Number.NaN, Number.POSITIVE_INFINITY, 10, 10]),
    ).toBe(10)
  })
})

describe('snapToFixedText - 結合: computeUniformFontSize（クランプ併用）', () => {
  it('snap 戻り値も RANGE クランプの対象（snap 後に MAX で頭打ち）', () => {
    // h=20 → sizeByHeight=20 → clamp 前 base=20。
    // 固定テキスト=[19, 19] → mode=19 は body band 9-14 から外れて除外（→ band フィルタで snap 無効）。
    // よって snap 後も 20 → clamp(20,9,18)=18（RANGE_MAX）。
    const fields = [makeField(20, 'a')]
    expect(
      computeUniformFontSize(fields, makeFont(1), undefined, undefined, [19, 19]),
    ).toBe(RANGE_MAX)
  })

  it('snap 後の値が RANGE 内なら snap 値がそのまま採用される', () => {
    // h=11 → base=11。固定テキスト=[12, 12, 10] → mode=12 → |12-11|=1.0 <= 1.0 → 12 にスナップ。
    // clamp(12,9,18)=12。
    const fields = [makeField(11, 'a')]
    expect(
      computeUniformFontSize(
        fields,
        makeFont(1),
        undefined,
        undefined,
        [12, 12, 10],
      ),
    ).toBe(12)
  })

  it('snap 後の値が RANGE_MIN を下回るならクランプで RANGE_MIN へ引き上げる', () => {
    // h=8 → base=8。clamp 前は 8 だが、固定テキスト=[9, 9] → mode=9 → |9-8|=1.0 <= 1.0 → 9。
    // clamp(9,9,18)=9。
    const fields = [makeField(8, 'a')]
    expect(
      computeUniformFontSize(fields, makeFont(1), undefined, undefined, [9, 9]),
    ).toBe(9)
  })

  it('fixedTextSizesPt 未指定なら snap 無効＝完全後方互換', () => {
    // 既存テストと同形: h=28/13/22 → min=13 → clamp(13,9,18)=13。
    const fields = [makeField(28, 'a'), makeField(13, 'b'), makeField(22, 'c')]
    expect(computeUniformFontSize(fields, makeFont(1))).toBe(13)
  })

  it('fixedTextSizesPt=[] でも snap 無効＝後方互換', () => {
    const fields = [makeField(28, 'a'), makeField(13, 'b'), makeField(22, 'c')]
    expect(
      computeUniformFontSize(fields, makeFont(1), undefined, undefined, []),
    ).toBe(13)
  })
})

describe('改善① 3 経路一致: 同入力で同 snap 結果（PDF/画像/canvas）', () => {
  it('同一 fields・同一 fixedTextSizesPt・同一 font なら出力は完全一致', () => {
    // overlay-generator / image-renderer / AdjustView の 3 経路は本純関数 1 本に集約済み。
    // 入力が同じなら出力も同じ（純関数）。本テストはその性質を明示的に固定する。
    const fields = [makeField(13, 'a'), makeField(22, 'b')]
    const fixed = [12, 12, 10]
    const font = makeFont(1)
    const a = computeUniformFontSize(fields, font, undefined, undefined, fixed)
    const b = computeUniformFontSize(fields, font, undefined, undefined, fixed)
    const c = computeUniformFontSize(fields, font, undefined, undefined, fixed)
    expect(a).toBe(b)
    expect(b).toBe(c)
    // base=13 → fixed mode=12 → |12-13|=1.0 → snap → 12 → clamp(12,9,18)=12。
    expect(a).toBe(12)
  })
})
