/**
 * computeRequiredBboxHeight 純関数 unit test。
 *
 * 検証観点:
 *   - 短文 1 行（wrap 行数 = 1）の最小ケース
 *   - 長文複数行（wrap 行数 ≥ 2）で h が線形に増える
 *   - 明示改行（\n）込みで段落 = 行数増
 *   - 空文字列 / 空段落も最低 1 行ぶん確保
 *   - fontSize 上下で h が線形に追従
 *   - padding 異なる field で h に padTop+padBottom が加算される
 *   - 縮小ケース（小 fontSize → 小 h）= テンプレ元 h を下限としない
 *   - fitting.ts wrapText の出力と整合（同じ font / fontSize / maxW で同じ行数）
 *   - 異常防御: bbox.w が padding 未満で maxW≤0 でも無限ループしない
 */
import { describe, it, expect } from 'vitest'
import {
  computeRequiredBboxHeight,
  LINE_GAP_MULT,
} from '@/lib/parsers/pdf/required-bbox-height'
import {
  wrapText,
  FIT_HEIGHT_RATIO,
  type FittableFont,
} from '@/lib/pdf-output/fitting'
import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'

/**
 * テスト用 fake font（CJK 想定）。
 * 1 文字 = `size` pt 幅と仮定（等幅・実フォントは異なるがロジック検証には十分）。
 * `heightAtSize` は使われないが構造的部分型を満たすため定義。
 */
function makeFakeFont(): FittableFont {
  return {
    widthOfTextAtSize: (text: string, size: number) => text.length * size,
    heightAtSize: (size: number) => size * 1.448, // 実 fontkit 概算（本関数では未使用）
  }
}

function makeField(overrides: Partial<PdfField> = {}): PdfField {
  return {
    name: 'sample',
    label: 'サンプル',
    type: 'text',
    bbox: { page: 1, x: 100, y: 200, w: 100, h: 24 },
    max_chars: 200,
    font: { family: 'NotoSansJP', size: 11 },
    padding: { left: 4, top: 4, right: 4, bottom: 4 },
    multiline: false,
    align: 'left',
    vertical: 'top',
    writing_mode: 'horizontal',
    overflow_strategy: 'shrink_then_wrap',
    font_size_min: 8,
    ...overrides,
  }
}

describe('computeRequiredBboxHeight', () => {
  const font = makeFakeFont()

  // v2.4.1 A 式（最終行 GAP 除外）期待値ヘルパー:
  //   requiredH = fontSize * FIT_HEIGHT_RATIO + (lineCount - 1) * lineHeightPt + padTop + padBottom
  function expectedH(
    fontSize: number,
    lineCount: number,
    padTop: number,
    padBottom: number,
  ): number {
    const lineHeightPt = fontSize * FIT_HEIGHT_RATIO * LINE_GAP_MULT
    return (
      fontSize * FIT_HEIGHT_RATIO +
      (lineCount - 1) * lineHeightPt +
      padTop +
      padBottom
    )
  }

  it('短文 1 行（wrap = 1 行）: fontSize + padTop + padBottom（A 式・「ぴったり」）', () => {
    // bbox.w=100, pad left/right=4 → maxW=92。fontSize=10 → 1文字10pt 幅。
    // 短い文字列 "abc" = 3*10=30 ≤ 92 → wrap 1 行。
    // v2.4.1: 1 行 = fontSize × FIT_HEIGHT_RATIO + padTop + padBottom = 10 + 4 + 4 = 18
    const field = makeField()
    const h = computeRequiredBboxHeight(field, 'abc', 10, font)
    expect(h).toBeCloseTo(expectedH(10, 1, 4, 4), 6)
    expect(h).toBeCloseTo(10 + 4 + 4, 6) // 「文字サイズぴったり」担保
  })

  it('長文で wrap 行数 = 2 → A 式 2 行ぶん + padding', () => {
    // maxW=92, fontSize=10 → 1 行に 9 文字（9*10=90 ≤ 92, 10*10=100 > 92）。
    // 12 文字 → 1 行目 9 文字 + 2 行目 3 文字 = 2 行。
    // v2.4.1: 10 + 1*12 + 8 = 30
    const field = makeField()
    const text = 'abcdefghijkl' // 12 chars
    const h = computeRequiredBboxHeight(field, text, 10, font)
    expect(h).toBeCloseTo(expectedH(10, 2, 4, 4), 6)
  })

  it('長文で wrap 行数 = 3 → A 式 3 行ぶん（GAP は最終行除外で 2 個ぶんのみ）', () => {
    // 同上 maxW=92, 1 行 9 文字。21 文字 → 3 行（9 + 9 + 3）。
    // v2.4.1: 10 + 2*12 + 8 = 42
    const field = makeField()
    const text = 'abcdefghijklmnopqrstu' // 21 chars
    const h = computeRequiredBboxHeight(field, text, 10, font)
    expect(h).toBeCloseTo(expectedH(10, 3, 4, 4), 6)
  })

  it('明示改行 \\n で段落数 = 行数増（multiline 想定）', () => {
    // 各段落短文 → 各 1 行。3 段落 = 3 行。
    const field = makeField({ multiline: true })
    const h = computeRequiredBboxHeight(field, 'a\nb\nc', 10, font)
    expect(h).toBeCloseTo(expectedH(10, 3, 4, 4), 6)
  })

  it('空段落（連続 \\n）も 1 行ぶん高さに含める', () => {
    // "a\n\nb" → 3 段落（"a", "", "b"）= 3 行。
    const field = makeField()
    const h = computeRequiredBboxHeight(field, 'a\n\nb', 10, font)
    expect(h).toBeCloseTo(expectedH(10, 3, 4, 4), 6)
  })

  it('空文字列 "" でも最低 1 行ぶん確保（textarea 高さ確保）', () => {
    const field = makeField()
    const h = computeRequiredBboxHeight(field, '', 10, font)
    // v2.4.1 A 式: 1 行 = fontSize + padTop + padBottom
    expect(h).toBeCloseTo(expectedH(10, 1, 4, 4), 6)
  })

  it('fontSize を上げると h が線形に拡張（拡大連動）', () => {
    const field = makeField()
    const text = 'abc' // 1 行確定
    const h10 = computeRequiredBboxHeight(field, text, 10, font)
    const h20 = computeRequiredBboxHeight(field, text, 20, font)
    expect(h10).toBeCloseTo(expectedH(10, 1, 4, 4), 6)
    expect(h20).toBeCloseTo(expectedH(20, 1, 4, 4), 6)
    // padding を除いた本体は A 式 1 行で fontSize × FIT_HEIGHT_RATIO のみ → 2 倍
    expect(h20 - 4 - 4).toBeCloseTo(2 * (h10 - 4 - 4), 6)
  })

  it('fontSize を下げると h も縮小（縮小も連動・テンプレ元 h を下限としない）', () => {
    // template 元 bbox.h=24 だが、A 式で fontSize=8pt + 1 行 → h = 8 + 8 = 16 ≤ 24 で縮小。
    const field = makeField({ bbox: { page: 1, x: 0, y: 0, w: 100, h: 24 } })
    const h = computeRequiredBboxHeight(field, 'ab', 8, font)
    expect(h).toBeCloseTo(expectedH(8, 1, 4, 4), 6)
    expect(h).toBeLessThan(field.bbox.h) // テンプレ元より小さい = 縮小連動
  })

  it('padding が異なる field で padTop + padBottom が加算される', () => {
    const fieldZero = makeField({
      padding: { left: 0, top: 0, right: 0, bottom: 0 },
    })
    const fieldPad = makeField({
      padding: { left: 0, top: 10, right: 0, bottom: 6 },
    })
    const h0 = computeRequiredBboxHeight(fieldZero, 'abc', 10, font)
    const hp = computeRequiredBboxHeight(fieldPad, 'abc', 10, font)
    expect(hp - h0).toBeCloseTo(10 + 6, 6)
  })

  it('fitting.ts wrapText の出力と行数が整合（同型化チェック）', () => {
    // 本関数の wrap 行数は fitting.ts wrapText と同じ font / fontSize / maxW で同じ結果になる必要がある
    // （fitMultiline 同型化: 3 経路が同一入力で同一行数を出力しないとレイアウトがずれる）。
    const field = makeField()
    const padLeft = field.padding.left
    const padRight = field.padding.right
    const maxW = field.bbox.w - padLeft - padRight
    const fontSize = 10
    const text = 'abcdefghijklmnopqrstuvwxyz' // 26 chars / 9 chars per line = 3 lines
    const wrappedLines = wrapText(text, maxW, font, fontSize)
    const h = computeRequiredBboxHeight(field, text, fontSize, font)
    // v2.4.1 A 式: fontSize + (lineCount - 1) * lineHeightPt + padTop + padBottom
    const lineH = fontSize * FIT_HEIGHT_RATIO * LINE_GAP_MULT
    expect(h).toBeCloseTo(
      fontSize * FIT_HEIGHT_RATIO +
        (wrappedLines.length - 1) * lineH +
        field.padding.top +
        field.padding.bottom,
      6,
    )
  })

  it('bbox.w が padding 未満（maxW≤0）でも無限ループせず 1 行ぶん返す（防御）', () => {
    const field = makeField({
      bbox: { page: 1, x: 0, y: 0, w: 4, h: 10 },
      padding: { left: 4, top: 2, right: 4, bottom: 2 }, // 横 pad 計 8 > w=4
    })
    const h = computeRequiredBboxHeight(field, 'abcdefg', 10, font)
    // 段落 1 つ → 防御で 1 行扱い → v2.4.1 A 式: 10 + 0 + 2 + 2 = 14
    expect(h).toBeCloseTo(expectedH(10, 1, 2, 2), 6)
  })

  it('LINE_GAP_MULT = 1.2（fitting.ts / canvas / overlay と同係数）', () => {
    // fitting.ts / canvas / overlay 3 経路で同係数を使うことで行高さが一致する（同型化保証）。
    expect(LINE_GAP_MULT).toBe(1.2)
  })

  it('短文 field 消失問題への構造解決', () => {
    // h=14, padding 上下 4pt の短文 field（消失問題の元事例）に対し、
    // v2.4.1 A 式: fontSize=14 で値ありなら requiredH = 14 + 0 + 4 + 4 = 22 ≥ 14（template 元）。
    // → 「lineExtentPx > maxHPx」のスキップが構造的に発生しない
    // （maxHPx = (22 - 8) * sy = 14 * sy ≥ lineExtentPx = 14 * sy で全行収まる）。
    const field = makeField({
      bbox: { page: 1, x: 0, y: 0, w: 200, h: 14 },
      padding: { left: 4, top: 4, right: 4, bottom: 4 },
    })
    const requiredH = computeRequiredBboxHeight(field, '日付', 14, font)
    expect(requiredH).toBeGreaterThan(14) // template 元 h より大きい = 拡張で消失回避
    // 残り高さ = requiredH - padTop - padBottom = A 式 1 行 → fontSize × FIT_HEIGHT_RATIO = 14
    // ≥ lineExtent = 14 * FIT_HEIGHT_RATIO = 14 で必ず収まる構造。
    const usable = requiredH - field.padding.top - field.padding.bottom
    const lineExtent = 14 * FIT_HEIGHT_RATIO
    expect(usable).toBeGreaterThanOrEqual(lineExtent)
  })

  // A 式: 1 行 = fontSize + pad（GAP 1.2 倍が乗らないことを明示）
  it('A 式: 1 行 field で requiredH === fontSize + padTop + padBottom（ぴったり）', () => {
    const field = makeField({
      bbox: { page: 1, x: 0, y: 0, w: 200, h: 50 },
      padding: { left: 4, top: 3, right: 4, bottom: 5 },
    })
    const fontSize = 12
    const h = computeRequiredBboxHeight(field, 'short', fontSize, font)
    // FIT_HEIGHT_RATIO === 1.0 前提（fitting.ts と整合）
    expect(h).toBeCloseTo(fontSize * FIT_HEIGHT_RATIO + 3 + 5, 6)
    // 「ぴったり」: GAP 1.2 倍が乗っていないことを明示
    expect(h).toBeLessThan(fontSize * LINE_GAP_MULT + 3 + 5)
  })
})
