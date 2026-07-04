/**
 * chat-to-fields.ts の normalizeMeetingDate 純関数テスト（GA8）。
 * ゲスト route / ログイン Server Action の両経路が共有する日付正規化ロジック。
 * 絶対日付（YYYY-MM-DD・実在日）のみ通し、相対表現・不正形式・実在しない日付は undefined。
 */
import { describe, it, expect } from 'vitest'
import {
  normalizeMeetingDate,
  buildChatToFieldsJsonSchema,
  SYSTEM_PROMPT_CHAT_TO_FIELDS,
} from '@/lib/ai/prompts/chat-to-fields'

describe('normalizeMeetingDate', () => {
  it('正しい ISO 日付はそのまま返す', () => {
    expect(normalizeMeetingDate('2026-07-15')).toBe('2026-07-15')
    expect(normalizeMeetingDate('2026-01-01')).toBe('2026-01-01')
    expect(normalizeMeetingDate('2026-12-31')).toBe('2026-12-31')
  })

  it('相対表現・自然言語は undefined', () => {
    expect(normalizeMeetingDate('来週')).toBeUndefined()
    expect(normalizeMeetingDate('今日')).toBeUndefined()
    expect(normalizeMeetingDate('来週の月曜')).toBeUndefined()
    expect(normalizeMeetingDate('7月15日')).toBeUndefined()
  })

  it('YYYY-MM-DD 形式でない文字列は undefined', () => {
    expect(normalizeMeetingDate('2026/07/15')).toBeUndefined()
    expect(normalizeMeetingDate('26-7-15')).toBeUndefined()
    expect(normalizeMeetingDate('2026-7-5')).toBeUndefined()
    expect(normalizeMeetingDate('')).toBeUndefined()
  })

  it('実在しない日付は undefined（堅牢化: Date round-trip チェック）', () => {
    expect(normalizeMeetingDate('2026-13-45')).toBeUndefined()
    expect(normalizeMeetingDate('2026-02-30')).toBeUndefined()
    expect(normalizeMeetingDate('2026-00-10')).toBeUndefined()
    expect(normalizeMeetingDate('2026-01-32')).toBeUndefined()
  })

  it('うるう年の 2 月 29 日は妥当', () => {
    // 2028 はうるう年。
    expect(normalizeMeetingDate('2028-02-29')).toBe('2028-02-29')
    // 2026 は平年 → 2/29 は存在しない。
    expect(normalizeMeetingDate('2026-02-29')).toBeUndefined()
  })

  it('string 以外の型は undefined', () => {
    expect(normalizeMeetingDate(undefined)).toBeUndefined()
    expect(normalizeMeetingDate(null)).toBeUndefined()
    expect(normalizeMeetingDate(20260715)).toBeUndefined()
    expect(normalizeMeetingDate({})).toBeUndefined()
  })
})

describe('buildChatToFieldsJsonSchema — GA8 meeting_date 追加', () => {
  it('meeting_date が properties に含まれ、required には含まれない（optional）', () => {
    const schema = buildChatToFieldsJsonSchema({
      fields: [{ name: 'attendees', label: '参加者' }],
    })
    const props = (schema as { properties: Record<string, unknown> }).properties
    expect(props.meeting_date).toBeDefined()
    expect((props.meeting_date as { type: string }).type).toBe('string')
    // required は ['values'] のまま（meeting_date は optional）。
    expect((schema as { required: string[] }).required).toEqual(['values'])
  })
})

describe('SYSTEM_PROMPT_CHAT_TO_FIELDS — GA8 開催日抽出ルール', () => {
  it('meeting_date と絶対日付のガイドがシステムプロンプトに含まれる', () => {
    expect(SYSTEM_PROMPT_CHAT_TO_FIELDS).toContain('meeting_date')
    expect(SYSTEM_PROMPT_CHAT_TO_FIELDS).toContain('YYYY-MM-DD')
  })
})
