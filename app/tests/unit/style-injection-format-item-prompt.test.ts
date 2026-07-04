/**
 * buildUserPromptFormatItem の pastExamples（few-shot）注入テスト。
 * 省略時 / 空配列は従来どおり（回帰）、指定時は例が連番付きで追加されることを確認する。
 */
import { describe, it, expect } from 'vitest'
import {
  buildUserPromptFormatItem,
  buildFormatItemSystemBlocks,
  SYSTEM_PROMPT_FORMAT_ITEM,
} from '@/lib/ai/prompts/format-item'

describe('buildUserPromptFormatItem', () => {
  it('pastExamples 省略時は従来どおりの本文のみを返す（回帰）', () => {
    const prompt = buildUserPromptFormatItem({
      fieldName: '決定事項',
      rawText: '来月の旅行は京都に決定',
      toneInstruction: 'トーン指示のテキスト',
    })
    expect(prompt).toContain('決定事項')
    expect(prompt).toContain('来月の旅行は京都に決定')
    expect(prompt).not.toContain('過去の同じ項目の例')
  })

  it('pastExamples が空配列でも従来どおり（回帰）', () => {
    const prompt = buildUserPromptFormatItem({
      fieldName: '決定事項',
      rawText: '来月の旅行は京都に決定',
      toneInstruction: 'トーン指示のテキスト',
      pastExamples: [],
    })
    expect(prompt).not.toContain('過去の同じ項目の例')
  })

  it('pastExamples 指定時は末尾に連番付きで追加される', () => {
    const prompt = buildUserPromptFormatItem({
      fieldName: '決定事項',
      rawText: '来月の旅行は京都に決定',
      toneInstruction: 'トーン指示のテキスト',
      pastExamples: ['先月は温泉旅行に決定した。', '今回は日帰りで実施することに決定した。'],
    })
    expect(prompt).toContain('過去の同じ項目の例')
    expect(prompt).toContain('1. 先月は温泉旅行に決定した。')
    expect(prompt).toContain('2. 今回は日帰りで実施することに決定した。')
  })
})

describe('buildFormatItemSystemBlocks', () => {
  it('styleSummary 省略時は base 1 block のみ・cache_control が維持される（回帰）', () => {
    const blocks = buildFormatItemSystemBlocks()
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toBe(SYSTEM_PROMPT_FORMAT_ITEM)
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('styleSummary が null の場合も base 1 block のみ', () => {
    const blocks = buildFormatItemSystemBlocks(null)
    expect(blocks).toHaveLength(1)
  })

  it('styleSummary 指定時は 2 つ目の block が cache_control 無しで追加される', () => {
    const blocks = buildFormatItemSystemBlocks('この家庭は敬体を好みます。')
    expect(blocks).toHaveLength(2)
    // base（1つ目）の cache_control は変わらないこと（既存キャッシュヒットを壊さない）
    expect(blocks[0].text).toBe(SYSTEM_PROMPT_FORMAT_ITEM)
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(blocks[1].text).toContain('この家庭は敬体を好みます。')
    expect(blocks[1].cache_control).toBeUndefined()
  })
})
