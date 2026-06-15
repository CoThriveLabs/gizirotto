/**
 * D3 案 B FB（実機検証・2026-06-09 真因 ①②）回帰防止 unit test。
 *
 * 真因まとめ:
 *   ① 旧 AdjustView.toPdfField は padding={left:2,top:2,right:2,bottom:2} 固定 →
 *      field-values-composite-canvas が maxW = bbox.w - 2 - 2 で wrap を判定し、
 *      PDF 経路（fitting.ts wrapText は実テンプレ padding=4 で maxW = bbox.w - 4 - 4）より
 *      広く取って改行が遅れていた。
 *   ② AdjustView 内 useMemo `fieldValuesUniformFontSize` も同じ toPdfField + 素 bbox.h で
 *      uniform 算出 → PDF 経路（applyBboxOverrides 後の effective + 実 padding）と乖離。
 *
 * 対策（本 commit）:
 *   - page.tsx で実テンプレ PdfField[] を抽出 → AdjustView へ props（pdfFields）
 *   - AdjustView `dynamicFieldValues` は lookupPdfField で実 PdfField を渡す
 *   - AdjustView `fieldValuesUniformFontSize` は `applyBboxOverrides(pdfFields, overrides)` 経由
 *
 * 本テストは「実 padding が canvas wrap maxW にそのまま流れ、fitting.ts wrapText 直接呼出と
 * 同じ wrap 結果が得られる」ことを padding=4 系で固定する。fitting-parity test は padding=0 で
 * 既存緑だが、真因 ① は padding≠0 でしか露呈しないため別ケースとして残す。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  compositeFieldValuesOnCanvas,
  type FieldValueComposite,
} from '@/lib/preview/field-values-composite-canvas'
import { wrapText, type FittableFont } from '@/lib/pdf-output/fitting'
import { computeUniformFontSize } from '@/lib/pdf-output/uniform-size'
import {
  applyBboxOverrides,
  type BboxOverrides,
} from '@/lib/pdf-output/field-override'
import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'

/** テンプレ DB 由来の実 PdfField を模す（padding=4 / multiline=true / font.size=12）。 */
function makeRealPdfField(overrides: Partial<PdfField> = {}): PdfField {
  return {
    name: 'gijiroku_body',
    label: '議事内容',
    type: 'text',
    bbox: { page: 1, x: 50, y: 300, w: 200, h: 100 },
    max_chars: 500,
    font: { family: 'NotoSansJP', size: 12 },
    padding: { left: 4, top: 4, right: 4, bottom: 4 },
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
    measureText: vi.fn(() => ({ width: 9999 })),
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

/** 決定的 fake font: 1 文字あたり size * 0.5pt 幅、heightAtSize = size。 */
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

describe('D3 案 B FB: pdfField props 経由で PDF と完全同型 wrap', () => {
  it('実 padding=4 系で canvas wrap が fitting.ts wrapText 直接呼出と一致', () => {
    const { canvas, ctx } = makeMockCanvas()
    const font = makeFakeFont()
    const fontPt = 14
    const realField = makeRealPdfField({
      // bbox.w=98 にして padding=2 vs 4 の差で 1 行文字数が 13→12 と必ずズレる構成にする。
      // - 旧 hardcode padding=2 → maxW=94 → 1 文字 7pt → 13.42 文字 = 13 文字/行
      // - 実 padding=4         → maxW=90 → 1 文字 7pt → 12.85 文字 = 12 文字/行
      // 35 文字テキストだと: 旧 = [13,13,9] / 新 = [12,12,11] で wrap 位置が必ず異なる。
      bbox: { page: 1, x: 0, y: 0, w: 98, h: 400 },
    })
    const text =
      'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめも' // 35 文字

    const items: FieldValueComposite[] = [{ field: realField, value: text }]
    compositeFieldValuesOnCanvas(canvas, items, 800, 1131, 595, 842, {
      uniformFontSize: fontPt,
      previewFont: font,
    })

    // PDF 経路と同型: fitting.ts wrapText を実 padding でそのまま呼ぶ。
    const maxWPt =
      realField.bbox.w - realField.padding.left - realField.padding.right
    const expectedLines = wrapText(text, maxWPt, font, fontPt)
    const actualLines = ctx.fillText.mock.calls.map((c) => c[0] as string)

    expect(actualLines).toEqual(expectedLines)
    // 真因 ① 回帰防止: 旧 padding=2 経路の wrap 結果と異なることを示す
    // （改行位置が遅れていたバグ）。
    const legacyWrong = wrapText(text, 98 - 2 - 2, font, fontPt)
    expect(actualLines).not.toEqual(legacyWrong)
  })

  it('uniform 算出が PDF 経路（applyBboxOverrides 後）と一致', () => {
    const font = makeFakeFont()
    // 実テンプレ: 場所欄（h=16, padding 4）と本文欄（h=100, padding 4）の 2 件。
    const pdfFields: PdfField[] = [
      makeRealPdfField({
        name: 'place',
        bbox: { page: 1, x: 0, y: 0, w: 80, h: 16 },
      }),
      makeRealPdfField({
        name: 'body',
        bbox: { page: 1, x: 0, y: 30, w: 200, h: 100 },
      }),
    ]
    const overrides: BboxOverrides = {
      // body のサイズを少し縮める override（applyBboxOverrides で effective.bbox.h が変わる）。
      body: { h: 90 },
    }
    const effective = applyBboxOverrides(pdfFields, overrides)
    const uniform = computeUniformFontSize(effective, font)

    // overlay-generator:158 と同じ式で uniform が算出されている前提。
    // 場所欄が最小欄基準（h=16, pad省略→UNIFORM_PAD=0 → sizeByHeight = 16 / 1.0 = 16pt）→ clamp で 16pt 確定。
    expect(uniform).toBe(16)

    // 旧経路（toPdfField 一律 padding=2 + 素 bbox.h）との差分も確認:
    //   uniform-size.sizeByHeight は padding 省略時 UNIFORM_PAD=0 で動くため、padding 差は
    //   uniform 値自体には乗らないが、effective bbox.h（override 反映後）は新経路でのみ反映。
    //   override.h=90 が反映されていることを別途確認:
    expect(effective.find((f) => f.name === 'body')?.bbox.h).toBe(90)
  })

  it('lookupPdfField 相当: dynamicFieldValues に渡る field の padding が実テンプレ値', () => {
    const { canvas, ctx } = makeMockCanvas()
    const font = makeFakeFont()
    const realField = makeRealPdfField({
      // 実テンプレで非対称な padding（旧 hardcode {2,2,2,2} と差が出やすい）
      padding: { left: 6, top: 4, right: 8, bottom: 4 },
      bbox: { page: 1, x: 0, y: 0, w: 100, h: 400 },
    })
    const text = 'あいうえおかきくけこさしすせそたちつてとなにぬねの' // 25 文字

    compositeFieldValuesOnCanvas(
      canvas,
      [{ field: realField, value: text }],
      800,
      1131,
      595,
      842,
      { uniformFontSize: 14, previewFont: font },
    )

    // maxW = 100 - 6 - 8 = 86pt
    const expected = wrapText(text, 100 - 6 - 8, font, 14)
    const actual = ctx.fillText.mock.calls.map((c) => c[0] as string)
    expect(actual).toEqual(expected)
  })
})
