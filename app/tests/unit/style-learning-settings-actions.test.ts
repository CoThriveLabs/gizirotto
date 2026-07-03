/**
 * 設定画面から呼ぶスタイル学習系 Server Action のユニットテスト。
 * getStyleLearningState / setStyleLearningEnabled / deleteStyleLearningData を対象に、
 * 正常系・未認証・family未所属・DBエラーの分岐を網羅する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  getSessionMock: vi.fn(),
  familiesSelectResult: vi.fn(),
  userStylesSelectResult: vi.fn(),
  familiesUpdateResult: vi.fn(),
  userStylesDeleteResult: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    auth: {
      getUser: mocks.getUserMock,
      getSession: mocks.getSessionMock,
    },
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      chain.select = vi.fn(() => chain)
      chain.eq = vi.fn(() => chain)
      chain.maybeSingle = vi.fn(() => {
        if (table === 'families') return mocks.familiesSelectResult()
        if (table === 'user_styles') return mocks.userStylesSelectResult()
        return Promise.resolve({ data: null, error: null })
      })
      chain.update = vi.fn(() => chain)
      chain.delete = vi.fn(() => chain)
      chain.then = (resolve: (v: unknown) => void) => {
        if (table === 'families') return Promise.resolve(mocks.familiesUpdateResult()).then(resolve)
        if (table === 'user_styles')
          return Promise.resolve(mocks.userStylesDeleteResult()).then(resolve)
        return Promise.resolve({ data: null, error: null }).then(resolve)
      }
      return chain
    },
  }),
}))

vi.mock('@/lib/jwt-claims', () => ({
  decodeAccessTokenClaims: (token: string | undefined) => {
    if (!token) return null
    if (token === 'no-family-token') return { family_id: null }
    return { family_id: 'family-1' }
  },
}))

import {
  getStyleLearningState,
  setStyleLearningEnabled,
  deleteStyleLearningData,
} from '@/server/style-profile'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getUserMock.mockResolvedValue({ data: { user: { id: 'user-1' } } })
  mocks.getSessionMock.mockResolvedValue({
    data: { session: { access_token: 'valid-token' } },
  })
  mocks.familiesSelectResult.mockResolvedValue({
    data: { style_learning_enabled: true },
    error: null,
  })
  mocks.userStylesSelectResult.mockResolvedValue({
    data: { last_updated_at: '2026-07-01T00:00:00.000Z' },
    error: null,
  })
  mocks.familiesUpdateResult.mockReturnValue({ error: null })
  mocks.userStylesDeleteResult.mockReturnValue({ error: null })
})

describe('getStyleLearningState', () => {
  it('未認証なら UNAUTHENTICATED を返す', async () => {
    mocks.getUserMock.mockResolvedValue({ data: { user: null } })
    const result = await getStyleLearningState()
    expect(result).toEqual({ ok: false, code: 'UNAUTHENTICATED' })
  })

  it('family未所属なら NOT_IN_FAMILY を返す', async () => {
    mocks.getSessionMock.mockResolvedValue({
      data: { session: { access_token: 'no-family-token' } },
    })
    const result = await getStyleLearningState()
    expect(result).toEqual({ ok: false, code: 'NOT_IN_FAMILY' })
  })

  it('正常系: 学習ON・プロファイル有りの状態を返す', async () => {
    const result = await getStyleLearningState()
    expect(result).toEqual({
      ok: true,
      enabled: true,
      hasProfile: true,
      lastUpdatedAt: '2026-07-01T00:00:00.000Z',
    })
  })

  it('プロファイル未生成なら hasProfile:false・lastUpdatedAt:null', async () => {
    mocks.userStylesSelectResult.mockResolvedValue({ data: null, error: null })
    const result = await getStyleLearningState()
    expect(result).toEqual({
      ok: true,
      enabled: true,
      hasProfile: false,
      lastUpdatedAt: null,
    })
  })

  it('families 行が取得できない場合も enabled:true 扱い（安全なデフォルト側）', async () => {
    mocks.familiesSelectResult.mockResolvedValue({ data: null, error: null })
    const result = await getStyleLearningState()
    expect(result).toMatchObject({ ok: true, enabled: true })
  })
})

describe('setStyleLearningEnabled', () => {
  it('未認証なら UNAUTHENTICATED を返す', async () => {
    mocks.getUserMock.mockResolvedValue({ data: { user: null } })
    const result = await setStyleLearningEnabled(false)
    expect(result).toEqual({ ok: false, code: 'UNAUTHENTICATED' })
  })

  it('正常系: 更新成功で ok:true を返す', async () => {
    const result = await setStyleLearningEnabled(false)
    expect(result).toEqual({ ok: true })
  })

  it('DB更新失敗時は DB_ERROR を返す', async () => {
    mocks.familiesUpdateResult.mockReturnValue({ error: { message: 'db error' } })
    const result = await setStyleLearningEnabled(true)
    expect(result).toEqual({ ok: false, code: 'DB_ERROR' })
  })
})

describe('deleteStyleLearningData', () => {
  it('未認証なら UNAUTHENTICATED を返す', async () => {
    mocks.getUserMock.mockResolvedValue({ data: { user: null } })
    const result = await deleteStyleLearningData()
    expect(result).toEqual({ ok: false, code: 'UNAUTHENTICATED' })
  })

  it('正常系: 削除成功で ok:true を返す', async () => {
    const result = await deleteStyleLearningData()
    expect(result).toEqual({ ok: true })
  })

  it('DB削除失敗時は DB_ERROR を返す', async () => {
    mocks.userStylesDeleteResult.mockReturnValue({ error: { message: 'db error' } })
    const result = await deleteStyleLearningData()
    expect(result).toEqual({ ok: false, code: 'DB_ERROR' })
  })
})
