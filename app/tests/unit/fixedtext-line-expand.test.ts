/**
 * `fixedTextToPseudoFieldsByLines` の単体テスト。
 *
 * 🔴 2026-06-14 改訂: bbox 内 縦横中央配置対応のため、本ヘルパは「行展開せず常に 1 件返す」
 *   仕様に変更（layoutFixedTextLines が下流で `\n` 分割と中央配置を一括で担う）。
 *   旧 v1.7 の `__L${i}` 展開・bbox.h=lineHeight 上書きは撤廃。元 ft.bbox（h 含む）を保持する。
 */
import { describe, it, expect } from 'vitest'
import { fixedTextToPseudoFieldsByLines } from '@/lib/pdf-output/regenerate-minute-pdf'
import type { FixedText } from '@/lib/pdf-output/fixedtext-adapter'

function ft(value: string, size = 16): FixedText {
  return {
    name: 'ft_1',
    value,
    bbox: { page: 1, x: 50, y: 100, w: 200, h: 20 },
    font: { family: 'NotoSansJP', size },
  }
}

describe('fixedTextToPseudoFieldsByLines（2026-06-14・行展開廃止・元 bbox 保持）', () => {
  it('空 value は何も返さない', () => {
    expect(fixedTextToPseudoFieldsByLines(ft(''))).toEqual([])
  })

  it('改行なし（単一行）は 1 つの field（name は元のまま・bbox.h 保持）', () => {
    const out = fixedTextToPseudoFieldsByLines(ft('会議名'))
    expect(out).toHaveLength(1)
    expect(out[0].field.name).toBe('ft_1') // suffix なし
    expect(out[0].value).toBe('会議名')
    expect(out[0].field.bbox.y).toBe(100)
    expect(out[0].field.bbox.h).toBe(20) // 元 bbox.h を保持（中央配置に必要）
  })

  it('改行ありでも 1 件のみ・value は改行込み・bbox は元 ft.bbox そのまま', () => {
    const out = fixedTextToPseudoFieldsByLines(ft('一行目\n二行目\n三行目', 16))
    expect(out).toHaveLength(1)
    expect(out[0].field.name).toBe('ft_1') // 行サフィックス無し
    expect(out[0].value).toBe('一行目\n二行目\n三行目') // value は改行込み
    expect(out[0].field.bbox.x).toBe(50)
    expect(out[0].field.bbox.y).toBe(100)
    expect(out[0].field.bbox.w).toBe(200)
    expect(out[0].field.bbox.h).toBe(20) // 元 bbox.h（中央配置の縦中央計算に使う）
    expect(out[0].field.bbox.page).toBe(1)
    expect(out[0].field.font.size).toBe(16)
  })

  it('空行を含む value も 1 件のみ（下流 layoutFixedTextLines が `\\n` 分割と中央配置を担う）', () => {
    const out = fixedTextToPseudoFieldsByLines(ft('A\n\nB'))
    expect(out).toHaveLength(1)
    expect(out[0].value).toBe('A\n\nB')
  })
})
