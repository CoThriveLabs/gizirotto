/**
 * maybeTriggerStyleProfile（初回スタイルプロファイル生成トリガ）テスト。
 * 「学習対象議事録が閾値にちょうど到達した時だけ生成が呼ばれる/超過・未満では呼ばれない」
 * 「学習OFF時は呼ばれない」「AI未設定時は呼ばれない」
 * 「quota超過時はAI呼出がスキップされる」「正常時はusageログが呼ばれる」を検証する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const buildStyleProfileMock = vi.fn()
vi.mock('@/lib/ai/style/build-style-profile', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/ai/style/build-style-profile')
  >('@/lib/ai/style/build-style-profile')
  return {
    ...actual,
    buildStyleProfile: (...args: unknown[]) => buildStyleProfileMock(...args),
  }
})

const checkAiUsageMock = vi.fn()
vi.mock('@/lib/ai-usage-guard', () => ({
  checkAiUsage: (...args: unknown[]) => checkAiUsageMock(...args),
}))

const logStyleProfileUsageMock = vi.fn()
vi.mock('@/lib/ai/style/log-style-profile-usage', () => ({
  logStyleProfileUsage: (...args: unknown[]) => logStyleProfileUsageMock(...args),
}))

import { maybeTriggerStyleProfile } from '@/lib/ai/style/maybe-trigger-style-profile'

/**
 * from('families').select().eq().maybeSingle() と
 * from('minutes').select(...).eq().eq() (count query) の両方をモックする最小 DB スタブ。
 */
function makeDb(args: {
  familyRow?: { style_learning_enabled: boolean } | null
  familyError?: unknown
  count: number | null
  countError?: unknown
}) {
  return {
    from: (table: string) => {
      if (table === 'families') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: args.familyRow ?? { style_learning_enabled: true },
                error: args.familyError ?? null,
              }),
            }),
          }),
        }
      }
      if (table === 'minutes') {
        return {
          select: () => ({
            eq: () => ({
              eq: async () => ({
                count: args.count,
                error: args.countError ?? null,
              }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

beforeEach(() => {
  buildStyleProfileMock.mockReset()
  buildStyleProfileMock.mockResolvedValue({ ok: true })
  checkAiUsageMock.mockReset()
  checkAiUsageMock.mockResolvedValue({ exceeded: false })
  logStyleProfileUsageMock.mockReset()
  logStyleProfileUsageMock.mockResolvedValue(undefined)
})

describe('maybeTriggerStyleProfile', () => {
  it('3件ちょうど到達で buildStyleProfile が呼ばれる', async () => {
    const db = makeDb({ count: 3 })
    await maybeTriggerStyleProfile({
      db,
      familyId: 'family-1',
      userId: 'user-1',
      anthropicApiKey: 'key',
      anthropicModel: 'model',
    })
    expect(buildStyleProfileMock).toHaveBeenCalledTimes(1)
    expect(buildStyleProfileMock.mock.calls[0][0]).toMatchObject({
      familyId: 'family-1',
      anthropicApiKey: 'key',
      anthropicModel: 'model',
    })
  })

  it('2件（閾値未満）では buildStyleProfile は呼ばれない', async () => {
    const db = makeDb({ count: 2 })
    await maybeTriggerStyleProfile({
      db,
      familyId: 'family-1',
      userId: 'user-1',
      anthropicApiKey: 'key',
      anthropicModel: 'model',
    })
    expect(buildStyleProfileMock).not.toHaveBeenCalled()
  })

  it('4件（閾値超過）でも buildStyleProfile は呼ばれない（毎回再生成はしない）', async () => {
    const db = makeDb({ count: 4 })
    await maybeTriggerStyleProfile({
      db,
      familyId: 'family-1',
      userId: 'user-1',
      anthropicApiKey: 'key',
      anthropicModel: 'model',
    })
    expect(buildStyleProfileMock).not.toHaveBeenCalled()
  })

  it('学習OFF（families.style_learning_enabled=false）では呼ばれない', async () => {
    const db = makeDb({ count: 3, familyRow: { style_learning_enabled: false } })
    await maybeTriggerStyleProfile({
      db,
      familyId: 'family-1',
      userId: 'user-1',
      anthropicApiKey: 'key',
      anthropicModel: 'model',
    })
    expect(buildStyleProfileMock).not.toHaveBeenCalled()
  })

  it('Anthropic API key未設定では呼ばれない', async () => {
    const db = makeDb({ count: 3 })
    await maybeTriggerStyleProfile({
      db,
      familyId: 'family-1',
      userId: 'user-1',
      anthropicApiKey: undefined,
      anthropicModel: 'model',
    })
    expect(buildStyleProfileMock).not.toHaveBeenCalled()
  })

  it('count取得エラー時は呼ばれず例外も投げない', async () => {
    const db = makeDb({ count: null, countError: { message: 'db error' } })
    await expect(
      maybeTriggerStyleProfile({
        db,
        familyId: 'family-1',
        userId: 'user-1',
        anthropicApiKey: 'key',
        anthropicModel: 'model',
      }),
    ).resolves.toBeUndefined()
    expect(buildStyleProfileMock).not.toHaveBeenCalled()
  })

  it('buildStyleProfile が例外を投げても呼出元に伝播しない', async () => {
    buildStyleProfileMock.mockRejectedValue(new Error('boom'))
    const db = makeDb({ count: 3 })
    await expect(
      maybeTriggerStyleProfile({
        db,
        familyId: 'family-1',
        userId: 'user-1',
        anthropicApiKey: 'key',
        anthropicModel: 'model',
      }),
    ).resolves.toBeUndefined()
  })

  it('minMinutes をカスタム指定した場合はその値と一致した時のみ発火する', async () => {
    const db = makeDb({ count: 5 })
    await maybeTriggerStyleProfile({
      db,
      familyId: 'family-1',
      userId: 'user-1',
      anthropicApiKey: 'key',
      anthropicModel: 'model',
      minMinutes: 5,
    })
    expect(buildStyleProfileMock).toHaveBeenCalledTimes(1)
  })

  it('quota超過時は checkAiUsage 後に buildStyleProfile がスキップされる', async () => {
    checkAiUsageMock.mockResolvedValue({ exceeded: true, reason: 'family_daily_limit' })
    const db = makeDb({ count: 3 })
    await maybeTriggerStyleProfile({
      db,
      familyId: 'family-1',
      userId: 'user-1',
      anthropicApiKey: 'key',
      anthropicModel: 'model',
    })
    expect(checkAiUsageMock).toHaveBeenCalledWith({ familyId: 'family-1', userId: 'user-1' })
    expect(buildStyleProfileMock).not.toHaveBeenCalled()
    expect(logStyleProfileUsageMock).not.toHaveBeenCalled()
  })

  it('quota超過時は例外を投げない（従来通り best-effort でスキップ）', async () => {
    checkAiUsageMock.mockResolvedValue({ exceeded: true, reason: 'family_daily_limit' })
    const db = makeDb({ count: 3 })
    await expect(
      maybeTriggerStyleProfile({
        db,
        familyId: 'family-1',
        userId: 'user-1',
        anthropicApiKey: 'key',
        anthropicModel: 'model',
      }),
    ).resolves.toBeUndefined()
  })

  it('正常時は buildStyleProfile の結果で logStyleProfileUsage が呼ばれる', async () => {
    const fakeResult = { ok: true, usage: { inputTokens: 100, outputTokens: 50 } }
    buildStyleProfileMock.mockResolvedValue(fakeResult)
    const db = makeDb({ count: 3 })
    await maybeTriggerStyleProfile({
      db,
      familyId: 'family-1',
      userId: 'user-1',
      anthropicApiKey: 'key',
      anthropicModel: 'model',
    })
    expect(logStyleProfileUsageMock).toHaveBeenCalledTimes(1)
    expect(logStyleProfileUsageMock).toHaveBeenCalledWith(fakeResult, {
      familyId: 'family-1',
      userId: 'user-1',
    })
  })
})
