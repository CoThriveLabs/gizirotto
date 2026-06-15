/**
 * 固定テキスト共有純関数 layoutFixedTextLines の単体テスト。
 *
 * 純関数なので measure コールバックを注入してエンジン非依存で論理を検証する。
 * measure は「CJK 1 文字 = 1em（size pt）・半角 = 0.5em」の単純近似でフェイクする
 * （実フォントメトリクスは経路側 canvas/pdf-lib の責務）。
 *
 * 配置仕様: bbox 内 縦横中央。各行ごとに metricsW から横中央オフセットを計算し、
 * ブロック総高を bbox.h の中央に置く。
 *
 * blockH 計算: `blockH = lastIndex*lineHeight + fontSize`。
 * （旧式 `(lastIndex+1)*lineHeight` は最終行の descent 余白を含み、文字が
 *  bbox 上部寄りに見える問題があったため、新式で「文字 em-box 中心 ≒ bbox 中心」となるよう調整）
 */
import { describe, it, expect } from 'vitest'
import {
  layoutFixedTextLines,
  FIXED_TEXT_FONT_SIZE_RATIO,
  FIXED_TEXT_DRAW_MIN_SIZE,
} from '@/lib/pdf-output/fixedtext-draw'

/** フェイク幅計測: CJK=1em・半角=0.5em。size はそのまま 1em の pt 幅とみなす。 */
function fakeMeasure(text: string, size: number): number {
  let em = 0
  for (const ch of text) em += /[\x00-\xff]/.test(ch) ? 0.5 : 1
  return em * size
}

describe('layoutFixedTextLines（bbox 内 縦横中央配置・2026-06-14）', () => {
  it('T-1/T-2: 枠に収まる「あいう」20pt は縮まず全文 1 行で出る（truncate しない）+ 横中央', () => {
    // 「あいう」= 3em。20pt で metricsW=60pt。bbox.w=100 → 縮小なし。
    // 横中央: x = 10 + (100 - 60)/2 = 30。
    // 縦中央（新式 2026-06-14）: lineHeight = 20/0.8 = 25。lastIndex=0。
    //   blockH = 0*25 + 20(fontSize) = 20（最終行 descent を除く）。
    //   topYPt = 20 + (50 - 20)/2 = 35。
    //   検算: 文字中心 35 + 20/2 = 45 = bbox.y + bbox.h/2 = 20 + 25 = 45 ✓
    const lines = layoutFixedTextLines(
      'あいう',
      { x: 10, y: 20, w: 100, h: 50 },
      20,
      fakeMeasure,
    )
    expect(lines).toHaveLength(1)
    expect(lines[0].text).toBe('あいう') // 1 文字も欠けない
    expect(lines[0].drawSize).toBe(20) // 保存サイズ維持
    expect(lines[0].xPt).toBe(30) // 横中央
    expect(lines[0].topYPt).toBe(35) // 縦中央（descent 除外で旧 32.5 → 35）
  })

  it('T-3: 縦中央オフセット後、行送りは fontSize / RATIO で進む（新式 blockH = lastIndex*lineHeight + fontSize）', () => {
    // 3 行（各 1em 「一」「二」「三」）。fontSize=10pt → metricsW=10。
    //   lineHeight = 10/0.8 = 12.5。lastIndex=2 → blockH = 2*12.5 + 10 = 35。
    //   bbox.y=100, bbox.h=100 → blockTop = 100 + (100-35)/2 = 132.5。
    //   topYPt = [132.5, 145, 157.5]。
    //   検算: 中央行（i=1）の文字中心 = 145 + 10/2 = 150 = bbox.y + bbox.h/2 = 150 ✓
    const lines = layoutFixedTextLines(
      '一\n二\n三',
      { x: 0, y: 100, w: 200, h: 100 },
      10,
      fakeMeasure,
    )
    const lineHeight = 10 / FIXED_TEXT_FONT_SIZE_RATIO // = 12.5
    const blockH = 2 * lineHeight + 10 // 新式 = 35
    const blockTop = 100 + (100 - blockH) / 2 // = 132.5
    expect(lines.map((l) => l.topYPt)).toEqual([
      blockTop,
      blockTop + lineHeight,
      blockTop + 2 * lineHeight,
    ])
  })

  it('T-4: 幅オーバーは縮小して全文表示（truncate しない）+ 縮小後幅で横中央', () => {
    // 「あいうえお」= 5em。20pt で metricsW=100。bbox.w=50 → drawSize = max(6, 20*50/100) = 10。
    // 縮小後 metricsW = 5em * 10 = 50。横中央 x = 0 + (50 - 50)/2 = 0（中央が左端と一致）。
    const lines = layoutFixedTextLines(
      'あいうえお',
      { x: 0, y: 0, w: 50, h: 50 },
      20,
      fakeMeasure,
    )
    expect(lines).toHaveLength(1)
    expect(lines[0].text).toBe('あいうえお') // 全文（…や省略なし）
    expect(lines[0].drawSize).toBeCloseTo(10, 5)
    expect(lines[0].xPt).toBeCloseTo(0, 5)
  })

  it('T-4: 極端な幅オーバーでも下限 FIXED_TEXT_DRAW_MIN_SIZE を下回らない', () => {
    // 100 文字を 20pt・bbox.w=10 → 縮小率が極小だが下限 6 でクランプ。
    // 縮小後 metricsW = 6 * 100 = 600 > bbox.w=10 → 横オフセット 0（左端）。
    const lines = layoutFixedTextLines(
      'あ'.repeat(100),
      { x: 0, y: 0, w: 10, h: 100 },
      20,
      fakeMeasure,
    )
    expect(lines[0].drawSize).toBe(FIXED_TEXT_DRAW_MIN_SIZE)
    expect(lines[0].text).toBe('あ'.repeat(100)) // truncate しない
    expect(lines[0].xPt).toBe(0) // 横はみ出し時は左端
  })

  it('T-7: 複数行は空行で lineIndex を進めつつ縦中央（新式 blockH = lastIndex*lineHeight + fontSize）', () => {
    // 「A\n\nB」: 1 行目 A(i=0)・空行(i=1・スキップ)・3 行目 B(i=2)。
    // metricsW(A)=0.5*8=4, metricsW(B)=0.5*8=4。lineHeight = 8/0.8 = 10。
    // 新式 blockH = lastIndex * lineHeight + fontSize = 2*10 + 8 = 28（空行送り込み・descent 除外）。
    // bbox.y=0, bbox.h=100 → blockTop = (100-28)/2 = 36。
    // A: topYPt = 36 + 0*10 = 36、B: topYPt = 36 + 2*10 = 56。
    // 検算: 視覚的ブロック中心（A 上端〜B 下端）= 36 → 36+28 → 中心 36+14 = 50 = bbox.y + bbox.h/2 = 50 ✓
    const lines = layoutFixedTextLines(
      'A\n\nB',
      { x: 5, y: 0, w: 200, h: 100 },
      8,
      fakeMeasure,
    )
    expect(lines).toHaveLength(2) // 空行は配列に出ない
    expect(lines[0].text).toBe('A')
    expect(lines[0].topYPt).toBe(36)
    expect(lines[1].text).toBe('B')
    expect(lines[1].topYPt).toBe(56)
  })

  it('T-N-1: 単一行・幅余裕あり → 横中央（bbox.x + (bbox.w - metricsW)/2）', () => {
    // 「ABC」= 1.5em。10pt で metricsW=15。bbox.x=100, bbox.w=100 → x = 100 + (100-15)/2 = 142.5。
    const lines = layoutFixedTextLines(
      'ABC',
      { x: 100, y: 0, w: 100, h: 50 },
      10,
      fakeMeasure,
    )
    expect(lines[0].xPt).toBeCloseTo(142.5, 5)
  })

  it('T-N-3: 複数行・各行幅が異なる → 各行ごとに個別中央', () => {
    // 「あ」=1em, 「あいう」=3em。10pt なら metricsW それぞれ 10, 30。
    // bbox.x=0, bbox.w=100 → x はそれぞれ (100-10)/2=45, (100-30)/2=35。
    const lines = layoutFixedTextLines(
      'あ\nあいう',
      { x: 0, y: 0, w: 100, h: 100 },
      10,
      fakeMeasure,
    )
    expect(lines).toHaveLength(2)
    expect(lines[0].xPt).toBeCloseTo(45, 5)
    expect(lines[1].xPt).toBeCloseTo(35, 5)
  })

  it('T-N-5: bbox.h が blockH より大きい場合は確実に縦中央（新式・オフセット正）', () => {
    // 「X」1 行、fontSize=10。lastIndex=0 → 新式 blockH = 0 + 10 = 10。
    // bbox.y=20, bbox.h=200 → topYPt = 20 + (200-10)/2 = 20 + 95 = 115。
    // 検算: 文字中心 115 + 10/2 = 120 = bbox.y + bbox.h/2 = 20 + 100 = 120 ✓
    const lines = layoutFixedTextLines(
      'X',
      { x: 0, y: 20, w: 100, h: 200 },
      10,
      fakeMeasure,
    )
    expect(lines[0].topYPt).toBeCloseTo(115, 5)
  })

  it('T-N-5b: bbox.h が blockH より小さい場合はオフセット 0（上端揃え・負方向にはみ出させない）', () => {
    // 5 行ぶんのブロックが bbox.h=10 を超える → 縦オフセットは max(0, ...) で 0。
    const lines = layoutFixedTextLines(
      '一\n二\n三\n四\n五',
      { x: 0, y: 50, w: 100, h: 10 },
      10,
      fakeMeasure,
    )
    // 1 行目 topYPt = bbox.y + 0 = 50（上端のまま）。
    expect(lines[0].topYPt).toBe(50)
  })

  it('空 value / 空白のみは空配列（0 件・無変化）', () => {
    expect(
      layoutFixedTextLines('', { x: 0, y: 0, w: 10, h: 10 }, 10, fakeMeasure),
    ).toEqual([])
    expect(
      layoutFixedTextLines('   ', { x: 0, y: 0, w: 10, h: 10 }, 10, fakeMeasure),
    ).toEqual([])
  })
})
