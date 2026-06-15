/**
 * field-values-composite-canvas × fitting.ts wrap 同型化テスト
 * （段階2-D3・設計書 v2.2 §1-2-6-3 fitMultiline 同型化）。
 *
 * 目的: previewFont 渡しありの場合、compositeFieldValuesOnCanvas 内部の wrap 結果が
 *   `fitting.ts` の `wrapText` を直接呼んだ結果と**文字列配列として完全一致**することを担保する
 *   （PDF 出力経路と動的プレビューの wrap 経路が物理的に 1 本である回帰防止）。
 *
 * 追加で:
 *   - lineHeight が `fontPt * LINE_GAP_MULT(1.2)` に一致（行送り係数の構造保証）
 *   - uniformFontSize が previewFont 経路でも維持される
 */
import { describe, it, expect, vi } from 'vitest'
import {
  compositeFieldValuesOnCanvas,
  type FieldValueComposite,
} from '@/lib/preview/field-values-composite-canvas'
import { wrapText, type FittableFont } from '@/lib/pdf-output/fitting'
import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'

function makeField(overrides: Partial<PdfField> = {}): PdfField {
  return {
    name: 'sample',
    label: 'サンプル',
    type: 'text',
    bbox: { page: 1, x: 0, y: 0, w: 100, h: 400 },
    max_chars: 200,
    font: { family: 'NotoSansJP', size: 11 },
    padding: { left: 0, top: 0, right: 0, bottom: 0 },
    multiline: true,
    align: 'left',
    vertical: 'top',
    writing_mode: 'horizontal',
    overflow_strategy: 'shrink_then_wrap',
    font_size_min: 8,
    ...overrides,
  }
}

interface MockCtx {
  save: ReturnType<typeof vi.fn>
  restore: ReturnType<typeof vi.fn>
  fillText: ReturnType<typeof vi.fn>
  measureText: ReturnType<typeof vi.fn>
  fillStyle: string
  font: string
  textBaseline: string
  clearRect: ReturnType<typeof vi.fn>
  drawImage: ReturnType<typeof vi.fn>
}

function makeMockCanvas(): { canvas: HTMLCanvasElement; ctx: MockCtx } {
  const ctx: MockCtx = {
    save: vi.fn(),
    restore: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 9999 })), // 使われないはず（previewFont 経路）
    fillStyle: '',
    font: '',
    textBaseline: '',
    clearRect: vi.fn(),
    drawImage: vi.fn(),
  }
  const canvas = {
    getContext: vi.fn(() => ctx),
    width: 800,
    height: 1131,
  } as unknown as HTMLCanvasElement
  return { canvas, ctx }
}

/**
 * 決定的 FittableFont（テスト用）: 1 文字あたり size * 0.5 pt の幅を返す。
 * これにより fitting.ts wrapText と compositeFieldValuesOnCanvas 内 wrap が
 * 同じメトリクスで動くため、両者の wrap 結果が完全一致するはず。
 */
function makeFakeFont(): FittableFont {
  return {
    widthOfTextAtSize(text: string, size: number) {
      return text.length * size * 0.5
    },
    heightAtSize(size: number) {
      return size * 1.0
    },
  }
}

describe('previewFont 渡し時の wrap 同型化（PDF 経路と完全一致）', () => {
  it('compositeFieldValuesOnCanvas 内 wrap が fitting.ts wrapText 直接呼出と文字列配列一致', () => {
    const { canvas, ctx } = makeMockCanvas()
    const font = makeFakeFont()
    const fontPt = 14
    // bbox.w=100pt, padding=0 → maxWPt=100
    // 1 文字 = 14*0.5=7pt → 100/7 ≈ 14.28 文字/行
    const text = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほ' // 30 文字
    const items: FieldValueComposite[] = [
      {
        field: makeField({
          bbox: { page: 1, x: 0, y: 0, w: 100, h: 400 },
        }),
        value: text,
      },
    ]

    compositeFieldValuesOnCanvas(canvas, items, 800, 1131, 595, 842, {
      uniformFontSize: fontPt,
      previewFont: font,
    })

    // fitting.ts wrapText を直接呼んで期待値を算出（経路同型保証）。
    const expectedLines = wrapText(text, 100, font, fontPt)

    // fillText 呼び出しの第 1 引数（行文字列）配列を抽出。
    const actualLines = ctx.fillText.mock.calls.map((c) => c[0] as string)

    expect(actualLines).toEqual(expectedLines)
    expect(actualLines.length).toBeGreaterThan(1) // wrap 発火確認
  })

  it('行送り = fontPx * 1.2（LINE_GAP_MULT・fitting.ts lineExtent*1.2 と同係数）', () => {
    const { canvas, ctx } = makeMockCanvas()
    const font = makeFakeFont()
    const fontPt = 14
    // sy = 1131 / 842 ≈ 1.3432
    const sy = 1131 / 842
    const fontPx = fontPt * sy
    const expectedLineHeightPx = fontPx * 1.2

    const items: FieldValueComposite[] = [
      {
        field: makeField({
          bbox: { page: 1, x: 0, y: 0, w: 100, h: 400 },
        }),
        value: 'あいうえおかきくけこさしすせそたちつてとなにぬねの',
      },
    ]
    compositeFieldValuesOnCanvas(canvas, items, 800, 1131, 595, 842, {
      uniformFontSize: fontPt,
      previewFont: font,
    })

    const calls = ctx.fillText.mock.calls
    expect(calls.length).toBeGreaterThanOrEqual(2)
    // 1 行目と 2 行目の y 差分が lineHeightPx と一致
    const y1 = calls[0][2] as number
    const y2 = calls[1][2] as number
    expect(y2 - y1).toBeCloseTo(expectedLineHeightPx, 3)
  })

  it('uniformFontSize が previewFont 経路でも維持される（override なし）', () => {
    const { canvas, ctx } = makeMockCanvas()
    const font = makeFakeFont()
    const items: FieldValueComposite[] = [
      { field: makeField({ font: { family: 'NotoSansJP', size: 11 } }), value: 'x' },
    ]
    compositeFieldValuesOnCanvas(canvas, items, 800, 1131, 595, 842, {
      uniformFontSize: 14,
      previewFont: font,
    })
    // 14 * (1131/842) ≈ 18.80px
    expect(ctx.font).toMatch(/18\.[0-9]+px/)
  })
})
