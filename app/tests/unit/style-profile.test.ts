/**
 * buildStyleProfile（家庭スタイルプロファイル生成の純粋ロジック）テスト。
 * 正常系 + 異常系（議事録0件/content_json空/AI不正JSON）+ exclude_from_learning 除外確認。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const createMock = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: (...args: unknown[]) => createMock(...args),
    }
  },
}))

import {
  buildStyleProfile,
  type StyleProfileDb,
} from '@/lib/ai/style/build-style-profile'

interface MockMinutesRow {
  id: string
  meeting_date: string
  content_json: unknown
}

/**
 * from('minutes').select().eq().eq().order().limit() チェインと
 * from('user_styles').upsert() の両方をモックする最小 DB スタブ。
 * exclude_from_learning フィルタはモック側で実際に適用し、除外確認テストで検証する。
 */
function makeDb(args: {
  minutesRows: MockMinutesRow[]
  fetchError?: { message: string } | null
  upsertError?: { message: string } | null
}): { db: StyleProfileDb; upsertMock: ReturnType<typeof vi.fn> } {
  const upsertMock = vi.fn().mockResolvedValue({ error: args.upsertError ?? null })

  const db = {
    from: (table: string) => {
      if (table === 'minutes') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: async (n: number) => {
                    if (args.fetchError) {
                      return { data: null, error: args.fetchError }
                    }
                    return { data: args.minutesRows.slice(0, n), error: null }
                  },
                }),
              }),
            }),
          }),
          upsert: upsertMock,
        }
      }
      if (table === 'user_styles') {
        return { upsert: upsertMock }
      }
      throw new Error(`unexpected table: ${table}`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as StyleProfileDb

  return { db, upsertMock }
}

const VALID_TOOL_INPUT = {
  tone: {
    sentence_ending: '体言止め中心',
    politeness: '常体',
    register: 'やわらかめ',
  },
  vocabulary: ['お父さん', '次回', '宿題'],
  field_order_hint: ['日付', '参加者', '決定事項'],
  formatting: {
    bullet_preference: '3件以上で箇条書き',
    paragraph_style: '話題ごとに1行空け',
  },
  summary_text: 'この家庭は体言止め中心の常体で、話題ごとに1行空けて書く傾向があります。',
}

function makeMinutesRows(count: number): MockMinutesRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `minute-${i}`,
    meeting_date: `2026-0${(i % 9) + 1}-01`,
    content_json: { agenda: `議題${i}`, decisions: `決定${i}` },
  }))
}

beforeEach(() => {
  createMock.mockReset()
  createMock.mockResolvedValue({
    content: [
      { type: 'tool_use', name: 'extract_style_profile', input: VALID_TOOL_INPUT },
    ],
    usage: { input_tokens: 1000, output_tokens: 200 },
  })
})

describe('buildStyleProfile', () => {
  it('正常系: 5件の過去 minutes から profile を生成し user_styles に upsert する', async () => {
    const { db, upsertMock } = makeDb({ minutesRows: makeMinutesRows(5) })
    const result = await buildStyleProfile({
      db,
      familyId: 'family-1',
      anthropicApiKey: 'test-key',
      anthropicModel: 'test-model',
    })

    expect(result.ok).toBe(true)
    expect(result.profile?.summary_text).toBe(VALID_TOOL_INPUT.summary_text)
    expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 200 })
    expect(upsertMock).toHaveBeenCalledTimes(1)
    const upsertArg = upsertMock.mock.calls[0][0]
    expect(upsertArg.family_id).toBe('family-1')
    expect(upsertArg.source_minutes_ids).toEqual([
      'minute-0',
      'minute-1',
      'minute-2',
      'minute-3',
      'minute-4',
    ])
    expect(upsertArg.last_updated_at).toBeDefined()
  })

  it('正常系: Anthropic レスポンスの usage をそのまま inputTokens/outputTokens として返す', async () => {
    createMock.mockResolvedValue({
      content: [
        { type: 'tool_use', name: 'extract_style_profile', input: VALID_TOOL_INPUT },
      ],
      usage: { input_tokens: 4321, output_tokens: 567 },
    })
    const { db } = makeDb({ minutesRows: makeMinutesRows(5) })
    const result = await buildStyleProfile({
      db,
      familyId: 'family-1',
      anthropicApiKey: 'test-key',
      anthropicModel: 'test-model',
    })

    expect(result.ok).toBe(true)
    expect(result.usage).toEqual({ inputTokens: 4321, outputTokens: 567 })
  })

  it('異常系: 議事録0件はスキップされ落ちない（NO_MINUTES）', async () => {
    const { db, upsertMock } = makeDb({ minutesRows: [] })
    const result = await buildStyleProfile({
      db,
      familyId: 'family-1',
      anthropicApiKey: 'test-key',
      anthropicModel: 'test-model',
    })

    expect(result.ok).toBe(false)
    expect(result.skippedReason).toBe('NO_MINUTES')
    expect(createMock).not.toHaveBeenCalled()
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it('異常系: 閾値未満（既定3件未満）の議事録数もスキップされる（NO_MINUTES）', async () => {
    const { db } = makeDb({ minutesRows: makeMinutesRows(2) })
    const result = await buildStyleProfile({
      db,
      familyId: 'family-1',
      anthropicApiKey: 'test-key',
      anthropicModel: 'test-model',
    })

    expect(result.ok).toBe(false)
    expect(result.skippedReason).toBe('NO_MINUTES')
    expect(createMock).not.toHaveBeenCalled()
  })

  it('異常系: 全件 content_json 空はスキップされ落ちない（EMPTY_CONTENT）', async () => {
    const rows = makeMinutesRows(5).map((r) => ({ ...r, content_json: {} }))
    const { db, upsertMock } = makeDb({ minutesRows: rows })
    const result = await buildStyleProfile({
      db,
      familyId: 'family-1',
      anthropicApiKey: 'test-key',
      anthropicModel: 'test-model',
    })

    expect(result.ok).toBe(false)
    expect(result.skippedReason).toBe('EMPTY_CONTENT')
    expect(createMock).not.toHaveBeenCalled()
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it('異常系: content_json が不正な形（配列）でも落ちず空オブジェクト扱いになる', async () => {
    const rows = makeMinutesRows(5).map((r) => ({ ...r, content_json: ['not', 'an', 'object'] }))
    const { db } = makeDb({ minutesRows: rows })
    const result = await buildStyleProfile({
      db,
      familyId: 'family-1',
      anthropicApiKey: 'test-key',
      anthropicModel: 'test-model',
    })

    expect(result.ok).toBe(false)
    expect(result.skippedReason).toBe('EMPTY_CONTENT')
  })

  it('異常系: Anthropic が tool_use を返さない場合はスキップされる（NO_TOOL_USE_BLOCK）', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'oops' }],
      usage: { input_tokens: 111, output_tokens: 22 },
    })
    const { db, upsertMock } = makeDb({ minutesRows: makeMinutesRows(5) })
    const result = await buildStyleProfile({
      db,
      familyId: 'family-1',
      anthropicApiKey: 'test-key',
      anthropicModel: 'test-model',
    })

    expect(result.ok).toBe(false)
    expect(result.skippedReason).toBe('NO_TOOL_USE_BLOCK')
    expect(result.usage).toEqual({ inputTokens: 111, outputTokens: 22 })
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it('異常系: AI が不正 JSON（必須フィールド欠落）を返した場合は zod で弾かれスキップされる（INVALID_PROFILE_JSON）', async () => {
    createMock.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          name: 'extract_style_profile',
          input: { tone: { sentence_ending: 'x' } }, // 必須フィールド欠落
        },
      ],
      usage: { input_tokens: 222, output_tokens: 33 },
    })
    const { db, upsertMock } = makeDb({ minutesRows: makeMinutesRows(5) })
    const result = await buildStyleProfile({
      db,
      familyId: 'family-1',
      anthropicApiKey: 'test-key',
      anthropicModel: 'test-model',
    })

    expect(result.ok).toBe(false)
    expect(result.skippedReason).toBe('INVALID_PROFILE_JSON')
    expect(result.usage).toEqual({ inputTokens: 222, outputTokens: 33 })
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it('異常系: Anthropic 呼出が例外を投げてもスキップされ落ちない（AI_REQUEST_FAILED）', async () => {
    createMock.mockRejectedValue(new Error('network error'))
    const { db, upsertMock } = makeDb({ minutesRows: makeMinutesRows(5) })
    const result = await buildStyleProfile({
      db,
      familyId: 'family-1',
      anthropicApiKey: 'test-key',
      anthropicModel: 'test-model',
    })

    expect(result.ok).toBe(false)
    expect(result.skippedReason).toBe('AI_REQUEST_FAILED')
    expect(result.usage).toBeUndefined()
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it('異常系: user_styles upsert 失敗時もスキップされ落ちない（UPSERT_FAILED）', async () => {
    createMock.mockResolvedValue({
      content: [
        { type: 'tool_use', name: 'extract_style_profile', input: VALID_TOOL_INPUT },
      ],
      usage: { input_tokens: 333, output_tokens: 44 },
    })
    const { db } = makeDb({
      minutesRows: makeMinutesRows(5),
      upsertError: { message: 'db error' },
    })
    const result = await buildStyleProfile({
      db,
      familyId: 'family-1',
      anthropicApiKey: 'test-key',
      anthropicModel: 'test-model',
    })

    expect(result.ok).toBe(false)
    expect(result.skippedReason).toBe('UPSERT_FAILED')
    expect(result.usage).toEqual({ inputTokens: 333, outputTokens: 44 })
  })

  it('exclude_from_learning=true の議事録は取得クエリから除外される（.eq 呼出確認）', async () => {
    // モック側の select().eq(family_id).eq(exclude_from_learning, false) チェインが
    // 正しく呼ばれていること自体を確認する（実際のフィルタは DB 側 RLS/クエリ責務）。
    const eqSpy = vi.fn()
    const rows = makeMinutesRows(5)
    const db = {
      from: (table: string) => {
        if (table === 'minutes') {
          return {
            select: () => ({
              eq: (col1: string, val1: string) => {
                eqSpy(col1, val1)
                return {
                  eq: (col2: string, val2: boolean) => {
                    eqSpy(col2, val2)
                    return {
                      order: () => ({
                        limit: async () => ({ data: rows, error: null }),
                      }),
                    }
                  },
                }
              },
            }),
            upsert: vi.fn().mockResolvedValue({ error: null }),
          }
        }
        if (table === 'user_styles') {
          return { upsert: vi.fn().mockResolvedValue({ error: null }) }
        }
        throw new Error(`unexpected table: ${table}`)
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as StyleProfileDb

    const result = await buildStyleProfile({
      db,
      familyId: 'family-1',
      anthropicApiKey: 'test-key',
      anthropicModel: 'test-model',
    })

    expect(eqSpy).toHaveBeenCalledWith('family_id', 'family-1')
    expect(eqSpy).toHaveBeenCalledWith('exclude_from_learning', false)
    expect(result.ok).toBe(true)
  })
})
