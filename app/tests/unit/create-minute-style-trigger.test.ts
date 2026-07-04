/**
 * createMinute（議事録新規作成 Server Action）の統合テスト。
 * 議事録作成完了後に maybeTriggerStyleProfile が正しい引数で呼ばれることを検証する。
 * PDF生成・bbox初期化等の既存挙動には触れず、スタイルプロファイル生成トリガの配線のみ確認する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

const mocks = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  getSessionMock: vi.fn(),
  templatesSelectResult: vi.fn(),
  minutesInsertResult: vi.fn(),
  maybeTriggerStyleProfileMock: vi.fn(),
  regenerateMinutePdfMock: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    auth: {
      getUser: mocks.getUserMock,
      getSession: mocks.getSessionMock,
    },
    from: (table: string) => {
      if (table === 'templates') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => mocks.templatesSelectResult(),
            }),
          }),
        }
      }
      if (table === 'minutes') {
        return {
          insert: () => ({
            select: () => ({
              single: () => mocks.minutesInsertResult(),
            }),
          }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }),
}))

vi.mock('@/lib/supabase/service', () => ({
  createSupabaseServiceClient: () => ({ __svc: true }),
}))

vi.mock('@/lib/jwt-claims', () => ({
  decodeAccessTokenClaims: () => ({ family_id: 'family-1' }),
}))

vi.mock('@/lib/pdf-output/regenerate-minute-pdf', () => ({
  regenerateMinutePdf: (...args: unknown[]) => mocks.regenerateMinutePdfMock(...args),
}))

vi.mock('@/lib/builtin-bbox-loader', () => ({
  loadBuiltinBboxOverrides: vi.fn(),
  resolveBuiltinBboxSlugFromProcessedPath: vi.fn(() => null),
}))

vi.mock('@/lib/ai/style/maybe-trigger-style-profile', () => ({
  maybeTriggerStyleProfile: (...args: unknown[]) => mocks.maybeTriggerStyleProfileMock(...args),
}))

import { createMinute } from '@/server/minutes/crud'

beforeEach(() => {
  vi.clearAllMocks()
  process.env.ANTHROPIC_API_KEY = 'test-key'
  process.env.ANTHROPIC_MODEL = 'test-model'
  mocks.getUserMock.mockResolvedValue({ data: { user: { id: 'user-1' } } })
  mocks.getSessionMock.mockResolvedValue({
    data: { session: { access_token: 'valid-token' } },
  })
  mocks.templatesSelectResult.mockResolvedValue({
    data: { family_id: 'family-1', processed_path: 'processed/foo.html' },
  })
  mocks.minutesInsertResult.mockResolvedValue({ data: { id: 'minute-1' }, error: null })
  mocks.regenerateMinutePdfMock.mockResolvedValue({ ok: true, outputPath: 'path.pdf' })
  mocks.maybeTriggerStyleProfileMock.mockResolvedValue(undefined)
})

const validInput = {
  templateId: '11111111-1111-1111-1111-111111111111',
  title: 'テスト議事録',
  meetingDate: '2026-07-04',
  content: { agenda: '議題1' },
  sourceMode: 'A-1' as const,
}

describe('createMinute のスタイルプロファイル生成トリガ配線', () => {
  it('議事録作成成功後、maybeTriggerStyleProfile が family_id・userId・AI設定付きで呼ばれる', async () => {
    const result = await createMinute(validInput)
    expect(result).toEqual({ id: 'minute-1' })
    expect(mocks.maybeTriggerStyleProfileMock).toHaveBeenCalledTimes(1)
    expect(mocks.maybeTriggerStyleProfileMock.mock.calls[0][0]).toMatchObject({
      familyId: 'family-1',
      userId: 'user-1',
      anthropicApiKey: 'test-key',
      anthropicModel: 'test-model',
    })
  })

  it('maybeTriggerStyleProfile が失敗しても createMinute 自体は成功する', async () => {
    mocks.maybeTriggerStyleProfileMock.mockRejectedValue(new Error('style profile failed'))
    const result = await createMinute(validInput)
    expect(result).toEqual({ id: 'minute-1' })
  })

  it('regenerateMinutePdf 失敗時も createMinute は成功し、スタイルトリガも呼ばれる', async () => {
    mocks.regenerateMinutePdfMock.mockResolvedValue({ ok: false, reason: 'FAILED' })
    const result = await createMinute(validInput)
    expect(result).toEqual({ id: 'minute-1' })
    expect(mocks.maybeTriggerStyleProfileMock).toHaveBeenCalledTimes(1)
  })
})
