/**
 * buildSystemA1Suffix / buildSystemA2Suffix の styleSummary 注入テスト。
 * 省略時は従来どおり（回帰）、指定時はスタイルブロックが追加されることを確認する。
 */
import { describe, it, expect } from 'vitest'
import { buildSystemA1Suffix } from '@/lib/ai/prompts/chat-a1'
import { buildSystemA2Suffix } from '@/lib/ai/prompts/chat-a2'

const templateFields = [
  { name: 'agenda', label: '議題' },
  { name: 'decisions', label: '決定事項' },
]

describe('buildSystemA1Suffix', () => {
  it('styleSummary 省略時は従来どおり項目リストのみを返す（回帰）', () => {
    const suffix = buildSystemA1Suffix({ templateFields })
    expect(suffix).toContain('議題（agenda）')
    expect(suffix).toContain('決定事項（decisions）')
    expect(suffix).not.toContain('この家庭の書き方の傾向')
  })

  it('styleSummary が null の場合も従来どおり（未生成時のフォールバック）', () => {
    const suffix = buildSystemA1Suffix({ templateFields, styleSummary: null })
    expect(suffix).not.toContain('この家庭の書き方の傾向')
  })

  it('styleSummary 指定時はスタイルブロックが末尾に追加される', () => {
    const suffix = buildSystemA1Suffix({
      templateFields,
      styleSummary: 'この家庭は体言止め中心で書く傾向があります。',
    })
    expect(suffix).toContain('この家庭の書き方の傾向')
    expect(suffix).toContain('この家庭は体言止め中心で書く傾向があります。')
    expect(suffix).toContain('事実は足さない')
  })
})

describe('buildSystemA2Suffix', () => {
  it('styleSummary 省略時は従来どおり項目リストのみを返す（回帰）', () => {
    const suffix = buildSystemA2Suffix({ templateFields })
    expect(suffix).toContain('議題（agenda）')
    expect(suffix).not.toContain('この家庭の書き方の傾向')
  })

  it('styleSummary 指定時はスタイルブロックが末尾に追加される', () => {
    const suffix = buildSystemA2Suffix({
      templateFields,
      styleSummary: 'やわらかい語尾を好む家庭です。',
    })
    expect(suffix).toContain('この家庭の書き方の傾向')
    expect(suffix).toContain('やわらかい語尾を好む家庭です。')
  })
})
