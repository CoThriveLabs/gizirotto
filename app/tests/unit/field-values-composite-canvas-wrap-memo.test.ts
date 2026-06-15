/**
 * field-values-composite-canvas wrap メモ化テスト
 * （段階2-D13 案1・移動ドラッグ中 opentype.js getAdvanceWidth 呼び出しゼロ化）。
 *
 * 目的:
 *   1. 同一 (para, maxWPt, fontPt) で 2 回合成すると 2 回目はキャッシュヒットし、
 *      wrapText（= preview-font-loader の getAdvanceWidth）を 1 回も呼ばない
 *      ＝「移動ドラッグ 2 フレーム目以降に glyph 計測ゼロ」を実証する。
 *   2. maxWPt（リサイズ）/ fontPt / para（テキスト編集）の変化でキャッシュ miss → 再計算。
 *   3. キャッシュ上限 2000 超過で clear される。
 *   4. メモ化前後で wrap 行分割が完全一致（回帰防止・代表ケース複数）。
 *
 * スパイ方式:
 *   フェイク FittableFont の `widthOfTextAtSize` を vi.fn() にする。fitting.ts wrapText は
 *   この関数を成長プレフィックスに 1 文字ずつ呼ぶ（O(N²)）ため、呼び出し回数 > 0 なら再 wrap、
 *   呼び出し回数 0 ならキャッシュヒット（実機の opentype.js getAdvanceWidth が呼ばれない状態）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  compositeFieldValuesOnCanvas,
  _resetWrapCache,
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
    measureText: vi.fn(() => ({ width: 9999 })), // previewFont 経路では使われない
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
 * スパイ付き決定的 FittableFont。
 * `widthOfTextAtSize` は 1 文字 = size * 0.5 pt を返す（fitting.ts wrapText と同メトリクス）。
 * vi.fn() なので「opentype.js getAdvanceWidth に相当する glyph 計測が何回呼ばれたか」を計数できる。
 */
function makeSpyFont(): FittableFont & {
  widthOfTextAtSize: ReturnType<typeof vi.fn>
} {
  return {
    widthOfTextAtSize: vi.fn((text: string, size: number) => text.length * size * 0.5),
    heightAtSize(size: number) {
      return size * 1.0
    },
  }
}

/** 800px / 595pt ではなく、page=595x842 / pixel=800x1131 を使う（既存テストと同条件）。 */
const PIXEL_W = 800
const PIXEL_H = 1131
const PAGE_W = 595
const PAGE_H = 842

beforeEach(() => {
  _resetWrapCache()
})

describe('D13 案1: wrap メモ化（移動ドラッグ中 glyph 計測ゼロ化）', () => {
  it('同一 (para,maxWPt,fontPt) 2 回呼びで wrap 結果一致 + 2 回目は getAdvanceWidth 呼び出し 0 回', () => {
    const font = makeSpyFont()
    const text = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほ' // 30 文字
    const items: FieldValueComposite[] = [
      { field: makeField({ bbox: { page: 1, x: 0, y: 0, w: 100, h: 400 } }), value: text },
    ]

    // 1 フレーム目（drag 開始）。
    const { canvas: c1, ctx: ctx1 } = makeMockCanvas()
    compositeFieldValuesOnCanvas(c1, items, PIXEL_W, PIXEL_H, PAGE_W, PAGE_H, {
      uniformFontSize: 14,
      previewFont: font,
    })
    const firstFrameLines = ctx1.fillText.mock.calls.map((call) => call[0] as string)
    const callsAfterFrame1 = font.widthOfTextAtSize.mock.calls.length
    expect(callsAfterFrame1).toBeGreaterThan(0) // 初回は実 wrap が走る
    expect(firstFrameLines.length).toBeGreaterThan(1) // wrap 発火確認

    // 2 フレーム目（x/y だけ動かした想定 = 同一 para/maxWPt/fontPt）。
    // bbox の x/y を変えても wrap キーは fontPt|maxWPt|para なので不変 → キャッシュヒット必須。
    font.widthOfTextAtSize.mockClear()
    const movedItems: FieldValueComposite[] = [
      { field: makeField({ bbox: { page: 1, x: 50, y: 80, w: 100, h: 400 } }), value: text },
    ]
    const { canvas: c2, ctx: ctx2 } = makeMockCanvas()
    compositeFieldValuesOnCanvas(c2, movedItems, PIXEL_W, PIXEL_H, PAGE_W, PAGE_H, {
      uniformFontSize: 14,
      previewFont: font,
    })
    const secondFrameLines = ctx2.fillText.mock.calls.map((call) => call[0] as string)

    // 🎯 核心: 2 フレーム目で glyph 計測（getAdvanceWidth 相当）が 1 回も走らない。
    expect(font.widthOfTextAtSize).not.toHaveBeenCalled()
    // wrap 結果（描画行）は完全一致（純粋最適化・ピクセル一致の担保）。
    expect(secondFrameLines).toEqual(firstFrameLines)
  })

  it('多数フレーム（移動 N 回）で 2 フレーム目以降の累積 glyph 計測が 0', () => {
    const font = makeSpyFont()
    const text = 'これはドラッグ中に位置だけ変わる長めの本文サンプルですよ' // 27 文字
    const baseItem = (x: number, y: number): FieldValueComposite => ({
      field: makeField({ bbox: { page: 1, x, y, w: 90, h: 400 } }),
      value: text,
    })

    // フレーム 1。
    compositeFieldValuesOnCanvas(
      makeMockCanvas().canvas,
      [baseItem(0, 0)],
      PIXEL_W,
      PIXEL_H,
      PAGE_W,
      PAGE_H,
      { uniformFontSize: 12, previewFont: font },
    )
    font.widthOfTextAtSize.mockClear()

    // フレーム 2〜30（位置だけ毎回変化）。
    for (let i = 1; i <= 29; i++) {
      compositeFieldValuesOnCanvas(
        makeMockCanvas().canvas,
        [baseItem(i * 3, i * 2)],
        PIXEL_W,
        PIXEL_H,
        PAGE_W,
        PAGE_H,
        { uniformFontSize: 12, previewFont: font },
      )
    }
    // 29 フレームぶんの累積 glyph 計測がゼロ。
    expect(font.widthOfTextAtSize).not.toHaveBeenCalled()
  })

  it('maxWPt 変化（リサイズ）でキャッシュ miss → 再計算', () => {
    const font = makeSpyFont()
    const text = 'あいうえおかきくけこさしすせそたちつてと'
    const run = (w: number) => {
      compositeFieldValuesOnCanvas(
        makeMockCanvas().canvas,
        [{ field: makeField({ bbox: { page: 1, x: 0, y: 0, w, h: 400 } }), value: text }],
        PIXEL_W,
        PIXEL_H,
        PAGE_W,
        PAGE_H,
        { uniformFontSize: 14, previewFont: font },
      )
    }
    run(100)
    font.widthOfTextAtSize.mockClear()
    run(80) // w 変化 → maxWPt 変化 → miss
    expect(font.widthOfTextAtSize).toHaveBeenCalled()
  })

  it('fontPt 変化でキャッシュ miss → 再計算', () => {
    const font = makeSpyFont()
    const text = 'あいうえおかきくけこさしすせそたちつてと'
    const run = (fontSize: number) => {
      compositeFieldValuesOnCanvas(
        makeMockCanvas().canvas,
        [{ field: makeField({ bbox: { page: 1, x: 0, y: 0, w: 100, h: 400 } }), value: text }],
        PIXEL_W,
        PIXEL_H,
        PAGE_W,
        PAGE_H,
        { uniformFontSize: fontSize, previewFont: font },
      )
    }
    run(14)
    font.widthOfTextAtSize.mockClear()
    run(18) // fontPt 変化 → miss
    expect(font.widthOfTextAtSize).toHaveBeenCalled()
  })

  it('para 変化（テキスト編集）でキャッシュ miss → 再計算', () => {
    const font = makeSpyFont()
    const run = (value: string) => {
      compositeFieldValuesOnCanvas(
        makeMockCanvas().canvas,
        [{ field: makeField({ bbox: { page: 1, x: 0, y: 0, w: 100, h: 400 } }), value }],
        PIXEL_W,
        PIXEL_H,
        PAGE_W,
        PAGE_H,
        { uniformFontSize: 14, previewFont: font },
      )
    }
    run('あいうえおかきくけこさしすせそ')
    font.widthOfTextAtSize.mockClear()
    run('あいうえおかきくけこさしすせそた') // 1 文字追加 → para 変化 → miss
    expect(font.widthOfTextAtSize).toHaveBeenCalled()
  })

  it('キャッシュ上限 2000 超過で clear される（新規 key が再計算される）', () => {
    const font = makeSpyFont()
    // 2000 件を超える異なる para を投入してキャッシュを満杯 → clear させる。
    // 各 para はユニーク（key も全部別）。短文 1 文字なら wrap は 1 行で必ず別 key。
    const items: FieldValueComposite[] = []
    for (let i = 0; i < 2001; i++) {
      // ユニーク文字列（同一 fontPt/maxWPt だが para が全部別 → 全部別 key）。
      items.push({
        field: makeField({ bbox: { page: 1, x: 0, y: 0, w: 1000, h: 4000 } }),
        value: `u${i}`,
      })
    }
    // 1 回の合成で 2001 件投入。size>=2000 到達時点で clear が走り、以降は新たに積む。
    compositeFieldValuesOnCanvas(
      makeMockCanvas().canvas,
      items,
      PIXEL_W,
      PIXEL_H,
      PAGE_W,
      PAGE_H,
      { uniformFontSize: 10, previewFont: font },
    )

    // clear が一度走っているので、最初に入れた key（u0）は既にキャッシュから消えているはず。
    // → u0 を再合成すると再計算（glyph 計測）が走る。
    font.widthOfTextAtSize.mockClear()
    compositeFieldValuesOnCanvas(
      makeMockCanvas().canvas,
      [{ field: makeField({ bbox: { page: 1, x: 0, y: 0, w: 1000, h: 4000 } }), value: 'u0' }],
      PIXEL_W,
      PIXEL_H,
      PAGE_W,
      PAGE_H,
      { uniformFontSize: 10, previewFont: font },
    )
    expect(font.widthOfTextAtSize).toHaveBeenCalled() // u0 は evict 済 → 再計算
  })

  it('上限内（最後に積んだ key）はヒットし続ける（clear 後の最新分は保持）', () => {
    const font = makeSpyFont()
    const items: FieldValueComposite[] = []
    for (let i = 0; i < 2001; i++) {
      items.push({
        field: makeField({ bbox: { page: 1, x: 0, y: 0, w: 1000, h: 4000 } }),
        value: `v${i}`,
      })
    }
    compositeFieldValuesOnCanvas(
      makeMockCanvas().canvas,
      items,
      PIXEL_W,
      PIXEL_H,
      PAGE_W,
      PAGE_H,
      { uniformFontSize: 10, previewFont: font },
    )
    // clear は size>=2000 到達時（v2000 投入前）に走る。clear 後に v2000 が積まれる。
    // → 最後に積まれた v2000 はキャッシュに残っているのでヒット。
    font.widthOfTextAtSize.mockClear()
    compositeFieldValuesOnCanvas(
      makeMockCanvas().canvas,
      [{ field: makeField({ bbox: { page: 1, x: 0, y: 0, w: 1000, h: 4000 } }), value: 'v2000' }],
      PIXEL_W,
      PIXEL_H,
      PAGE_W,
      PAGE_H,
      { uniformFontSize: 10, previewFont: font },
    )
    expect(font.widthOfTextAtSize).not.toHaveBeenCalled() // v2000 は保持 → ヒット
  })
})

describe('D13 案1: メモ化前後で wrap 行分割が完全一致（回帰防止・代表ケース）', () => {
  const cases: { name: string; text: string; w: number; fontSize: number }[] = [
    { name: '長文 30 文字 / 狭幅', text: 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほ', w: 100, fontSize: 14 },
    { name: '改行混在（段落 3 つ）', text: 'いちぎょうめ\nにぎょうめのほうがすこしながい\nさんぎょうめ', w: 120, fontSize: 12 },
    { name: '空行を含む', text: 'うえのだんらく\n\nしたのだんらく', w: 100, fontSize: 11 },
    { name: '1 文字 fit（wrap なし）', text: 'あ', w: 100, fontSize: 14 },
    { name: '幅ぴったりで 1 文字目強制改行', text: 'あいうえお', w: 4, fontSize: 14 },
  ]

  for (const tc of cases) {
    it(`memoWrap 経由の描画行が fitting.ts wrapText 直接呼出と一致: ${tc.name}`, () => {
      _resetWrapCache()
      const font = makeSpyFont()
      const { canvas, ctx } = makeMockCanvas()
      // h を十分大きく取り、はみ出しスキップが起きないようにする（行分割そのものを検証）。
      const field = makeField({ bbox: { page: 1, x: 0, y: 0, w: tc.w, h: 100000 } })
      compositeFieldValuesOnCanvas(
        canvas,
        [{ field, value: tc.text }],
        PIXEL_W,
        PIXEL_H,
        PAGE_W,
        PAGE_H,
        { uniformFontSize: tc.fontSize, previewFont: font },
      )
      const actualLines = ctx.fillText.mock.calls.map((call) => call[0] as string)

      // 期待値: 各段落（\n split）を fitting.ts wrapText 直接呼出（空行は描画なし=送るのみ）。
      const padLeftRight = 0
      const maxWPt = Math.max(0, tc.w - padLeftRight)
      const expected: string[] = []
      for (const para of tc.text.split('\n')) {
        if (para === '') continue // 空行は fillText されない（lineIndex だけ進む）
        for (const line of wrapText(para, maxWPt, font, tc.fontSize)) {
          expected.push(line)
        }
      }
      expect(actualLines).toEqual(expected)
    })
  }
})
