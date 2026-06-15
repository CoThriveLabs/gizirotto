import { describe, it, expect } from 'vitest'
import { ordinalLabel } from '@/lib/utils/ordinal-label'

describe('ordinalLabel (G1-⑤案2 連番総称ラベル)', () => {
  it('1〜20 は丸数字に変換', () => {
    expect(ordinalLabel(1)).toBe('①')
    expect(ordinalLabel(2)).toBe('②')
    expect(ordinalLabel(10)).toBe('⑩')
    expect(ordinalLabel(20)).toBe('⑳')
  })

  it('21 以降は桁あふれ fallback で通常数字', () => {
    expect(ordinalLabel(21)).toBe('21')
    expect(ordinalLabel(100)).toBe('100')
  })

  it('範囲外（0 以下）は通常数字 fallback', () => {
    expect(ordinalLabel(0)).toBe('0')
    expect(ordinalLabel(-1)).toBe('-1')
  })

  it('「その他の項目」+ 連番で英語キーが出ないことを確認', () => {
    const labels = [0, 1, 2].map((i) => `その他の項目${ordinalLabel(i + 1)}`)
    expect(labels).toEqual([
      'その他の項目①',
      'その他の項目②',
      'その他の項目③',
    ])
  })
})
