/**
 * compositeFieldValuesOnCanvas 純関数 unit test
 * （段階2-D2・設計書 v2.0 §1-2 / §1-2-3 / §1-2-4・§7-B 焼き込み残り二重描画ゼロ）。
 *
 * jsdom 環境では HTMLCanvasElement.getContext('2d') が返す ctx が描画 API を全部
 * モックしてくれないため、本テストは「合成順を呼出側責務にする pure な振る舞い」を
 * **モック ctx**で確認する:
 *
 *   - items=[] / value 空 / value 全空白 → 何も描かない（fillText 呼ばれない）
 *   - 正常 1 件 → fillText 1 回・ctx.font が設定されている
 *   - 改行入り value → fillText が行数ぶん呼ばれる（空行はスキップ）
 *   - per-field override.fontSize 指定 → uniform 未使用（override 優先）
 *   - uniformFontSize 指定 + override.fontSize 無し → uniform を使用
 *   - override.x/y/w 反映で fillText の引数が変わる
 *   - 横はみ出し → fontSize 縮小（drawSize 再設定 / Math.max(6, ...)）
 *   - canvas.getContext が null → 例外を吐かず no-op
 *
 * 合成順（背景 → 白塗り → 固定テキスト → 記入値）の検証は呼出側（BboxPane）の責務なので、
 * ここは純関数の「重ね描画だけ・clearRect なし・drawImage なし」を担保するに留める。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  compositeFieldValuesOnCanvas,
  type FieldValueComposite,
} from '@/lib/preview/field-values-composite-canvas'
import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'

function makeField(overrides: Partial<PdfField> = {}): PdfField {
  return {
    name: 'sample',
    label: 'サンプル',
    type: 'text',
    bbox: { page: 1, x: 100, y: 200, w: 300, h: 24 },
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

function makeMockCanvas(measureWidth = 10): {
  canvas: HTMLCanvasElement
  ctx: MockCtx
} {
  const ctx: MockCtx = {
    save: vi.fn(),
    restore: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: measureWidth })),
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

describe('compositeFieldValuesOnCanvas', () => {
  it('items が空配列なら getContext すら呼ばない（早期 return）', () => {
    const { canvas, ctx } = makeMockCanvas()
    compositeFieldValuesOnCanvas(canvas, [], 800, 1131, 595, 842)
    expect(ctx.save).not.toHaveBeenCalled()
    expect(ctx.fillText).not.toHaveBeenCalled()
  })

  it('value 空文字のみは何も描かない（fillText 呼ばれない）', () => {
    const { canvas, ctx } = makeMockCanvas()
    const items: FieldValueComposite[] = [{ field: makeField(), value: '' }]
    compositeFieldValuesOnCanvas(canvas, items, 800, 1131, 595, 842)
    expect(ctx.fillText).not.toHaveBeenCalled()
  })

  it('value が全空白のみも描かない（trim 後 0 文字）', () => {
    const { canvas, ctx } = makeMockCanvas()
    const items: FieldValueComposite[] = [{ field: makeField(), value: '   ' }]
    compositeFieldValuesOnCanvas(canvas, items, 800, 1131, 595, 842)
    expect(ctx.fillText).not.toHaveBeenCalled()
  })

  it('正常 1 件 → fillText 1 回・ctx.fillStyle と textBaseline 設定', () => {
    const { canvas, ctx } = makeMockCanvas()
    const items: FieldValueComposite[] = [
      { field: makeField(), value: 'こんにちは' },
    ]
    compositeFieldValuesOnCanvas(canvas, items, 800, 1131, 595, 842)
    expect(ctx.fillText).toHaveBeenCalledTimes(1)
    expect(ctx.fillStyle).toBe('#000000')
    expect(ctx.textBaseline).toBe('top')
    expect(ctx.save).toHaveBeenCalledTimes(1)
    expect(ctx.restore).toHaveBeenCalledTimes(1)
  })

  it('改行 \\n 入り value → fillText が行数ぶん呼ばれる（空行はスキップ）', () => {
    const { canvas, ctx } = makeMockCanvas()
    const items: FieldValueComposite[] = [
      {
        // bbox.h を 3 行分以上確保して bbox 高さスキップを発火させない（§1-2-5 hi 高さガード）。
        field: makeField({
          bbox: { page: 1, x: 100, y: 200, w: 300, h: 100 },
        }),
        value: '1行目\n\n3行目', // 2 行目は空
      },
    ]
    compositeFieldValuesOnCanvas(canvas, items, 800, 1131, 595, 842)
    expect(ctx.fillText).toHaveBeenCalledTimes(2)
  })

  it('override.fontSize 指定で uniform は無視（override 優先）', () => {
    const { canvas, ctx } = makeMockCanvas()
    const items: FieldValueComposite[] = [
      {
        field: makeField({ font: { family: 'NotoSansJP', size: 11 } }),
        value: 'x',
        override: { fontSize: 18 },
      },
    ]
    compositeFieldValuesOnCanvas(canvas, items, 800, 1131, 595, 842, {
      uniformFontSize: 14, // 指定しても override 18 が勝つ
    })
    // ctx.font は "18*sy px ..." 形（sy=1131/842 ≈ 1.343 → 約 24.18px）
    expect(ctx.font).toMatch(/24\.\d/)
  })

  it('uniformFontSize 指定 + override 無しなら uniform を使う', () => {
    const { canvas, ctx } = makeMockCanvas()
    const items: FieldValueComposite[] = [
      { field: makeField({ font: { family: 'NotoSansJP', size: 11 } }), value: 'x' },
    ]
    compositeFieldValuesOnCanvas(canvas, items, 800, 1131, 595, 842, {
      uniformFontSize: 14,
    })
    // 14 * (1131/842) ≈ 18.80px
    expect(ctx.font).toMatch(/18\.[0-9]+px/)
  })

  it('uniform / override どちらも無いと field.font.size を使う', () => {
    const { canvas, ctx } = makeMockCanvas()
    const items: FieldValueComposite[] = [
      { field: makeField({ font: { family: 'NotoSansJP', size: 11 } }), value: 'x' },
    ]
    compositeFieldValuesOnCanvas(canvas, items, 800, 1131, 595, 842)
    // 11 * (1131/842) ≈ 14.77px
    expect(ctx.font).toMatch(/14\.[0-9]+px/)
  })

  it('override.x/y 反映で fillText 引数（x, y）が変わる', () => {
    const { canvas, ctx } = makeMockCanvas()
    const items: FieldValueComposite[] = [
      {
        field: makeField(),
        value: 'a',
        override: { x: 0, y: 0 }, // override で原点へ
      },
    ]
    compositeFieldValuesOnCanvas(canvas, items, 800, 1131, 595, 842)
    const call = ctx.fillText.mock.calls[0]
    // padding.left=4, padding.top=4, sx=800/595, sy=1131/842
    // x = 0*sx + 4*sx = 4 * 1.345 ≈ 5.378
    // y = 0*sy + 4*sy = 4 * 1.343 ≈ 5.372
    expect(call[1]).toBeCloseTo(5.378, 1)
    expect(call[2]).toBeCloseTo(5.372, 1)
  })

  // 🔴 v2.1 §1-2-5: 横はみ出しは「縮小」ではなく「wrap 折返し」になった。
  // 旧テスト（縮小確認）は仕様変更で廃止し、wrap 挙動の回帰防止テストへ置き換える。
  it('🔴 v2.1 §1-2-5: 横はみ出しは縮小せず wrap 折返しで複数行に分割', () => {
    const { canvas, ctx } = makeMockCanvas(99999) // measureText が常に巨大幅を返す = 必ずはみ出す
    const items: FieldValueComposite[] = [
      {
        field: makeField({
          bbox: { page: 1, x: 0, y: 0, w: 50, h: 200 }, // 狭い w + 十分な h
          padding: { left: 0, top: 0, right: 0, bottom: 0 },
        }),
        value: 'はみ出す長い文字列',
      },
    ]
    compositeFieldValuesOnCanvas(canvas, items, 800, 1131, 595, 842)
    // measureText が常に巨大なので各文字が独立 1 行になる → fillText が複数回呼ばれる
    expect(ctx.fillText.mock.calls.length).toBeGreaterThan(1)
    // 🔴 §1-2-5 核心: ctx.font は wrap 中に**一度も変わらない**（縮小禁止）
    // → 最後にセットされた ctx.font は item の決定値そのまま（14.77px ≈ 11 * 1131/842）
    expect(ctx.font).toMatch(/14\.[0-9]+px/)
  })

  it('🔴 v2.1 §1-2-5: 段落（\\n 区切り）ごとにフォントサイズがバラバラにならない', () => {
    const { canvas, ctx } = makeMockCanvas(10) // measureText 小さく返す = はみ出さない
    const items: FieldValueComposite[] = [
      {
        field: makeField({
          bbox: { page: 1, x: 0, y: 0, w: 300, h: 400 },
          padding: { left: 0, top: 0, right: 0, bottom: 0 },
        }),
        value: '短',
      },
      {
        field: { ...makeField(), name: 'long' },
        value: 'これはとても長い段落です'.repeat(3),
      },
    ]
    compositeFieldValuesOnCanvas(canvas, items, 800, 1131, 595, 842, {
      uniformFontSize: 14,
    })
    // 全 fillText 呼び出しの ctx.font は全て同じ（途中で変わらない）
    // モック実装では ctx.font は最後の代入値だけ残るが、本テストの趣旨は
    // 「縮小ロジックが存在しない＝ ctx.font に途中で異なる値が代入されない」こと。
    // ctx.font の最終値が item.font.size = 14pt から計算される値であることを確認。
    expect(ctx.font).toMatch(/18\.[0-9]+px/) // 14 * 1131/842 ≈ 18.80px
  })

  it('🔴 v2.1 §1-2-5: bbox 高さからはみ出す行は描画スキップ', () => {
    const { canvas, ctx } = makeMockCanvas(99999) // 全文字独立 1 行 → 大量の行
    const items: FieldValueComposite[] = [
      {
        field: makeField({
          bbox: { page: 1, x: 0, y: 0, w: 50, h: 30 }, // 高さ 30 = 約 2 行分のみ
          padding: { left: 0, top: 0, right: 0, bottom: 0 },
        }),
        value: 'あいうえおかきくけこ', // 10 文字 → 10 行 wrap される
      },
    ]
    compositeFieldValuesOnCanvas(canvas, items, 800, 1131, 595, 842)
    // bbox 高さ 30pt * sy ≈ 40.3px・1 行 ≈ 14.77px → 約 2 行分が描画される
    // 10 文字全部は描画されない（bbox 内のみ）
    expect(ctx.fillText.mock.calls.length).toBeLessThan(10)
    expect(ctx.fillText.mock.calls.length).toBeGreaterThan(0)
  })

  it('canvas.getContext が null を返したら no-op（throw しない）', () => {
    const canvas = {
      getContext: vi.fn(() => null),
      width: 800,
      height: 1131,
    } as unknown as HTMLCanvasElement
    const items: FieldValueComposite[] = [{ field: makeField(), value: 'x' }]
    expect(() =>
      compositeFieldValuesOnCanvas(canvas, items, 800, 1131, 595, 842),
    ).not.toThrow()
  })

  it('clearRect / drawImage を呼ばない（合成順は呼出側責務）', () => {
    const { canvas, ctx } = makeMockCanvas()
    const items: FieldValueComposite[] = [{ field: makeField(), value: 'x' }]
    compositeFieldValuesOnCanvas(canvas, items, 800, 1131, 595, 842)
    expect(ctx.clearRect).not.toHaveBeenCalled()
    expect(ctx.drawImage).not.toHaveBeenCalled()
  })

  // 🔴 段階2-D5（ユーザー実機フィードバック 2026-06-08）: effPad 対称化解除。
  //   D4 で bbox.h が requiredH（A 式 = fontSize + (n-1)*1.2*fontSize + padTop + padBottom）に
  //   構造連動したため、D3 で導入した uniform 駆動時 effPad=0 特殊化は副作用（上辺ギリギリ・
  //   下辺と差）の元に転落。effPad を実 pad に統一し、上下対称配置 + 全行描画を成立させる。
  it('🔴 D5: 短文 field（h=22=A 式 / pad=4 一律）+ uniform=14pt で 1 行描画される', () => {
    const { canvas, ctx } = makeMockCanvas(10) // 短い文字列ははみ出さない
    const items: FieldValueComposite[] = [
      {
        // bbox.h=22pt（D4 A 式: fontSize 14 + pad 上下計 8 = 22）/ pad={4,4,4,4} / uniform=14pt。
        // 新実装: maxHPx=(22-8)*sy=14*sy ≈ 18.80px, lineExtentPx=14*sy ≈ 18.80px → 18.80≤18.80 で 1 行入る。
        field: makeField({
          bbox: { page: 1, x: 100, y: 200, w: 100, h: 22 },
          padding: { left: 4, top: 4, right: 4, bottom: 4 },
          font: { family: 'NotoSansJP', size: 11 },
        }),
        value: '2026/06/08',
      },
    ]
    compositeFieldValuesOnCanvas(canvas, items, 800, 1131, 595, 842, {
      uniformFontSize: 14,
    })
    expect(ctx.fillText).toHaveBeenCalledTimes(1)
  })

  it('🔴 D5: uniform 駆動でも effPad は実 pad（上下対称配置・yTopPx = bbox.y*sy + padTop*sy）', () => {
    // D3 では uniform 駆動時 effPad=0 化していたため yTopPx=bbox.y*sy となり「上辺ギリギリ」だった。
    // D5 では実 padTop を常用 → yTopPx = bbox.y*sy + padTop*sy で上下対称配置になる。
    const { canvas, ctx } = makeMockCanvas(10)
    const items: FieldValueComposite[] = [
      {
        field: makeField({
          bbox: { page: 1, x: 0, y: 0, w: 100, h: 22 }, // y=0 で yTopPx は純粋に padTop*sy
          padding: { left: 4, top: 4, right: 4, bottom: 4 },
          font: { family: 'NotoSansJP', size: 11 },
        }),
        value: 'A',
      },
    ]
    compositeFieldValuesOnCanvas(canvas, items, 800, 1131, 595, 842, {
      uniformFontSize: 14, // uniform 駆動経路
    })
    expect(ctx.fillText).toHaveBeenCalledTimes(1)
    const call = ctx.fillText.mock.calls[0]
    // sy = 1131/842, padTop = 4 → yTopPx = 0*sy + 4*sy ≈ 5.372（D3 では 0 だった）
    expect(call[2]).toBeCloseTo(4 * (1131 / 842), 2)
  })

  it('🔴 D5: override.fontSize 経路でも実 pad を適用（uniform 経路との挙動一致）', () => {
    // D3 では uniform 経路と override 経路で effPad が分岐していたが、D5 では撤廃され一律実 pad。
    // bbox.h=22（A 式整合）/ pad=4 上下 / override.fontSize=14 → uniform 経路と同じく 1 行入る。
    const { canvas, ctx } = makeMockCanvas(10)
    const items: FieldValueComposite[] = [
      {
        field: makeField({
          bbox: { page: 1, x: 100, y: 200, w: 100, h: 22 },
          padding: { left: 4, top: 4, right: 4, bottom: 4 },
          font: { family: 'NotoSansJP', size: 11 },
        }),
        value: 'X',
        override: { fontSize: 14 },
      },
    ]
    compositeFieldValuesOnCanvas(canvas, items, 800, 1131, 595, 842, {
      uniformFontSize: 14,
    })
    // 新実装: maxHPx=(22-8)*sy ≈ 18.80px, lineExtentPx=14*sy ≈ 18.80px → 1 行入る
    expect(ctx.fillText).toHaveBeenCalledTimes(1)
  })

  it('🔴 案A+B 回帰防止: 長文 field（h=200 / 議事内容相当）の描画行数が変化しない', () => {
    // h=200pt は uniform 駆動でも非駆動でも maxHPx が十分大きい（200pt ≈ 268px）。
    // pad=4 でも pad=0 でも 1 行以上描画可能で、行数も同じになることを担保。
    const { canvas, ctx } = makeMockCanvas(10)
    const items: FieldValueComposite[] = [
      {
        field: makeField({
          bbox: { page: 1, x: 100, y: 200, w: 400, h: 200 },
          padding: { left: 4, top: 4, right: 4, bottom: 4 },
          font: { family: 'NotoSansJP', size: 11 },
        }),
        value: '行1\n行2\n行3', // 3 段落（明示改行）
      },
    ]
    compositeFieldValuesOnCanvas(canvas, items, 800, 1131, 595, 842, {
      uniformFontSize: 14,
    })
    expect(ctx.fillText).toHaveBeenCalledTimes(3)
  })

  it('fontFamily / fillStyle オプション反映', () => {
    const { canvas, ctx } = makeMockCanvas()
    const items: FieldValueComposite[] = [{ field: makeField(), value: 'x' }]
    compositeFieldValuesOnCanvas(canvas, items, 800, 1131, 595, 842, {
      fontFamily: '"MyFont", serif',
      fillStyle: '#ff0000',
    })
    expect(ctx.fillStyle).toBe('#ff0000')
    expect(ctx.font).toContain('"MyFont", serif')
  })
})
