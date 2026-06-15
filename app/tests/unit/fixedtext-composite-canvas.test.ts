/**
 * fixedtext-composite-canvas（#17・v1.8 §3-3-2）の単体テスト。
 *
 * 動的プレビュー方式: raw 背景に「白塗り → 固定テキスト」の順で canvas 合成する純関数。
 * 焼き込み（v1.6.3 #15）は撤回し、本ヘルパに統一。
 *
 * 検証観点:
 *  1. 空 texts なら canvas を書き換えない（fillText が呼ばれない）
 *  2. value 非空なら fillText が呼ばれる
 *  3. trim 空・空行はスキップ
 *  4. 複数行（\n 含む value）は行数ぶん fillText が呼ばれ、各行の y は lineHeight ずつ下げる
 *  5. 失敗時方針: ctx が取れない（getContext null）等の異常は早期 return（throw しない）
 *
 * 注: 実フォント描画の見た目検証はサムネ側 fixedtext-composite.test.ts と同様に困難なため、
 *   本テストでは ctx の fillText/save/restore 呼出をモックで観測する論理検証に絞る。
 */
import { describe, it, expect, vi } from 'vitest'
import { compositeFixedTextsOnCanvas } from '@/lib/preview/fixedtext-composite-canvas'
import { FIXED_TEXT_FONT_SIZE_RATIO } from '@/lib/pdf-output/fixedtext-adapter'
import type { FixedText } from '@/lib/pdf-output/fixedtext-adapter'

/** HTMLCanvasElement 互換の最小スタブ。fillText 呼出のみ記録する。 */
function makeCanvasStub(): {
  canvas: HTMLCanvasElement
  fillTextCalls: Array<{ text: string; x: number; y: number }>
} {
  const fillTextCalls: Array<{ text: string; x: number; y: number }> = []
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    fillStyle: '',
    textBaseline: '',
    font: '',
    measureText: (s: string) => ({ width: s.length * 10 }),
    fillText: (text: string, x: number, y: number) => {
      fillTextCalls.push({ text, x, y })
    },
  }
  const canvas = {
    getContext: (kind: string) => (kind === '2d' ? ctx : null),
  } as unknown as HTMLCanvasElement
  return { canvas, fillTextCalls }
}

function ft(
  page: number,
  x: number,
  y: number,
  w: number,
  h: number,
  value: string,
  fontSize = 12,
): FixedText {
  return {
    name: `ft_${page}`,
    value,
    bbox: { page, x, y, w, h },
    font: { family: 'NotoSansJP', size: fontSize },
  }
}

describe('compositeFixedTextsOnCanvas（ブラウザ Canvas2D 版・#17）', () => {
  it('texts 空なら getContext すら呼ばず早期 return（fillText 呼出ゼロ）', () => {
    const { canvas, fillTextCalls } = makeCanvasStub()
    compositeFixedTextsOnCanvas(canvas, [], 100, 100, 100, 100)
    expect(fillTextCalls.length).toBe(0)
  })

  it('value 非空 1 行は fillText が 1 回呼ばれる（縦横中央・新式 blockH=fontSize・2026-06-14）', () => {
    const { canvas, fillTextCalls } = makeCanvasStub()
    // sx=sy=1。measureText は `s.length * 10`（HELLO=50）。fontPx=12, lineHeight=15。
    // bbox(x=10,y=30,w=100,h=20) → 横中央: 10 + (100-50)/2 = 35。
    // 縦中央（新式）: lastIndex=0 → blockH = 0 + 12(fontSize) = 12。
    //   y = 30 + (20-12)/2 = 34。
    //   検算: 文字中心 34 + 12/2 = 40 = bbox.y + bbox.h/2 = 30 + 10 = 40 ✓
    compositeFixedTextsOnCanvas(
      canvas,
      [ft(1, 10, 30, 100, 20, 'HELLO', 12)],
      100,
      100,
      100,
      100,
    )
    expect(fillTextCalls.length).toBe(1)
    expect(fillTextCalls[0].text).toBe('HELLO')
    expect(fillTextCalls[0].x).toBeCloseTo(35, 5)
    expect(fillTextCalls[0].y).toBeCloseTo(34, 5)
  })

  it('trim 空 value は描画スキップ', () => {
    const { canvas, fillTextCalls } = makeCanvasStub()
    compositeFixedTextsOnCanvas(
      canvas,
      [ft(1, 10, 30, 100, 20, '   ')],
      100,
      100,
      100,
      100,
    )
    expect(fillTextCalls.length).toBe(0)
  })

  it('複数行 value（\\n 含む）は各行ぶん fillText が呼ばれ、縦中央 + 行送り + 行ごと横中央', () => {
    const { canvas, fillTextCalls } = makeCanvasStub()
    // sx=sy=1 / fontSize=12pt → fontPx=12 → lineHeight = 12 / 0.8 = 15。
    // bbox(x=10,y=10,w=200,h=30)。新式 blockH = lastIndex*lineHeight + fontSize = 2*15 + 12 = 42
    //   > bbox.h=30 → 縦オフセット 0（上端揃え）。
    // 横中央: measureText は `s.length * 10` → A=10, BB=20, CCC=30。
    //   A: 10 + (200-10)/2 = 105, BB: 10 + (200-20)/2 = 100, CCC: 10 + (200-30)/2 = 95。
    compositeFixedTextsOnCanvas(
      canvas,
      [ft(1, 10, 10, 200, 30, 'A\nBB\nCCC', 12)],
      200,
      100,
      200,
      100,
    )
    expect(fillTextCalls.length).toBe(3)
    const expectedLineH = 12 / FIXED_TEXT_FONT_SIZE_RATIO
    expect(fillTextCalls[0]).toMatchObject({ text: 'A', x: 105, y: 10 })
    expect(fillTextCalls[1]).toMatchObject({ text: 'BB', x: 100, y: 10 + expectedLineH })
    expect(fillTextCalls[2]).toMatchObject({ text: 'CCC', x: 95, y: 10 + 2 * expectedLineH })
  })

  it('空行（連続 \\n）は描画スキップだが lineIndex は進む（後続行は縦中央 + 適切な送り位置）', () => {
    const { canvas, fillTextCalls } = makeCanvasStub()
    // 3 行ぶん（A・空・C）→ 新式 blockH = 2*15 + 12 = 42 > bbox.h=30 → 縦オフセット 0。
    compositeFixedTextsOnCanvas(
      canvas,
      [ft(1, 10, 10, 200, 30, 'A\n\nC', 12)],
      200,
      100,
      200,
      100,
    )
    // 1 行目 A, 2 行目空（skip）, 3 行目 C → 2 回 fillText。
    expect(fillTextCalls.length).toBe(2)
    const expectedLineH = 12 / FIXED_TEXT_FONT_SIZE_RATIO
    expect(fillTextCalls[0]).toMatchObject({ text: 'A', y: 10 })
    expect(fillTextCalls[1]).toMatchObject({ text: 'C', y: 10 + 2 * expectedLineH })
  })
})
