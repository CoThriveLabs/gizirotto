/**
 * deleteMyAccount Server Action ユニットテスト。
 *
 * Supabase クライアントを丸ごとモックし、ケース A/B/C と各エラー分岐を網羅する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- module mocks (vi.hoisted で hoisting の制約をパス) -----------
const mocks = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  signInWithPasswordMock: vi.fn(),
  deleteUserMock: vi.fn(),
  resolveFamilyIdMock: vi.fn(),
  familyMembersResult: vi.fn(),
  familiesDeleteResult: vi.fn(),
  chatSessionsDeleteResult: vi.fn(),
  familyMembersDeleteResult: vi.fn(),
  storageListResult: vi.fn(),
  storageRemoveResult: vi.fn(),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: (_url: string, key: string) => {
    if (key === 'publishable-key') {
      return {
        auth: {
          signInWithPassword: mocks.signInWithPasswordMock,
        },
      }
    }
    return makeAdminClient()
  },
}))

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    auth: {
      getUser: mocks.getUserMock,
    },
  }),
}))

vi.mock('@/lib/supabase/admin-client', () => ({
  createSupabaseAdminClient: () => makeAdminClient(),
}))

vi.mock('@/lib/ai-usage-guard', () => ({
  resolveFamilyIdByUser: mocks.resolveFamilyIdMock,
}))

function makeAdminClient() {
  return {
    auth: {
      admin: {
        deleteUser: mocks.deleteUserMock,
      },
    },
    from: (table: string) => {
      const promiseForSelect = () => {
        if (table === 'family_members') return mocks.familyMembersResult()
        return Promise.resolve({ data: [], error: null })
      }
      const promiseForDelete = () => {
        if (table === 'families') return mocks.familiesDeleteResult()
        if (table === 'chat_sessions') return mocks.chatSessionsDeleteResult()
        if (table === 'family_members') return mocks.familyMembersDeleteResult()
        return Promise.resolve({ data: null, error: null })
      }
      const selectChain: Record<string, unknown> = {
        maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
      }
      selectChain.eq = vi.fn(() => selectChain)
      selectChain.then = (resolve: (v: unknown) => void) =>
        promiseForSelect().then(resolve)

      const deleteChain: Record<string, unknown> = {}
      deleteChain.eq = vi.fn(() => deleteChain)
      deleteChain.then = (resolve: (v: unknown) => void) =>
        promiseForDelete().then(resolve)

      return {
        select: vi.fn(() => selectChain),
        delete: vi.fn(() => deleteChain),
      }
    },
    storage: {
      from: (_bucket: string) => ({
        list: mocks.storageListResult,
        remove: mocks.storageRemoveResult,
      }),
    },
  }
}

import { deleteMyAccount } from '@/server/account'

const ME = 'user-me'
const OTHER = 'user-other'
const FAMILY_ID = 'family-123'

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'publishable-key'
  process.env.SUPABASE_SECRET_KEY = 'secret-key'
  global.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))

  mocks.storageListResult.mockResolvedValue({ data: [], error: null })
  mocks.storageRemoveResult.mockResolvedValue({ data: null, error: null })
  mocks.familiesDeleteResult.mockResolvedValue({ error: null })
  mocks.chatSessionsDeleteResult.mockResolvedValue({ error: null })
  mocks.familyMembersDeleteResult.mockResolvedValue({ error: null })
  mocks.deleteUserMock.mockResolvedValue({ data: null, error: null })
  mocks.resolveFamilyIdMock.mockResolvedValue(FAMILY_ID)
})

describe('deleteMyAccount', () => {
  it('confirmText が DELETE でないと CONFIRM_TEXT_MISMATCH', async () => {
    const res = await deleteMyAccount({ confirmText: 'wrong' })
    expect(res).toEqual({ ok: false, code: 'CONFIRM_TEXT_MISMATCH' })
  })

  it('未認証なら UNAUTHENTICATED', async () => {
    mocks.getUserMock.mockResolvedValue({ data: { user: null } })
    const res = await deleteMyAccount({ confirmText: 'DELETE' })
    expect(res).toEqual({ ok: false, code: 'UNAUTHENTICATED' })
  })

  it('パスワード渡しで誤り → WRONG_PASSWORD', async () => {
    mocks.getUserMock.mockResolvedValue({
      data: { user: { id: ME, email: 'me@example.com', identities: [] } },
    })
    mocks.signInWithPasswordMock.mockResolvedValue({
      data: null,
      error: { message: 'invalid' },
    })
    const res = await deleteMyAccount({
      confirmText: 'DELETE',
      password: 'wrong',
    })
    expect(res).toEqual({ ok: false, code: 'WRONG_PASSWORD' })
  })

  it('パスワード未渡しで進行 (magic link only)', async () => {
    mocks.getUserMock.mockResolvedValue({
      data: { user: { id: ME, email: 'me@example.com', identities: [] } },
    })
    mocks.familyMembersResult.mockResolvedValue({
      data: [{ user_id: ME, role: 'member' }],
      error: null,
    })
    const res = await deleteMyAccount({ confirmText: 'DELETE' })
    expect(res).toEqual({ ok: true, case: 'family_deleted' })
    expect(mocks.signInWithPasswordMock).not.toHaveBeenCalled()
  })

  it('ケース A: 自分だけのとき family_deleted', async () => {
    mocks.getUserMock.mockResolvedValue({
      data: { user: { id: ME, email: 'me@example.com', identities: [] } },
    })
    mocks.familyMembersResult.mockResolvedValue({
      data: [{ user_id: ME, role: 'admin' }],
      error: null,
    })
    const res = await deleteMyAccount({ confirmText: 'DELETE' })
    expect(res).toEqual({ ok: true, case: 'family_deleted' })
    expect(mocks.deleteUserMock).toHaveBeenCalledWith(ME)
  })

  it('ケース B: 唯一 admin × 他メンバー残 → SOLE_ADMIN_BLOCKED', async () => {
    mocks.getUserMock.mockResolvedValue({
      data: { user: { id: ME, email: 'me@example.com', identities: [] } },
    })
    mocks.familyMembersResult.mockResolvedValue({
      data: [
        { user_id: ME, role: 'admin' },
        { user_id: OTHER, role: 'member' },
      ],
      error: null,
    })
    const res = await deleteMyAccount({ confirmText: 'DELETE' })
    expect(res).toEqual({ ok: false, code: 'SOLE_ADMIN_BLOCKED' })
    expect(mocks.deleteUserMock).not.toHaveBeenCalled()
  })

  it('ケース C: 他メンバー + 別 admin 居 → left_family', async () => {
    mocks.getUserMock.mockResolvedValue({
      data: { user: { id: ME, email: 'me@example.com', identities: [] } },
    })
    mocks.familyMembersResult.mockResolvedValue({
      data: [
        { user_id: ME, role: 'member' },
        { user_id: OTHER, role: 'admin' },
      ],
      error: null,
    })
    const res = await deleteMyAccount({ confirmText: 'DELETE' })
    expect(res).toEqual({ ok: true, case: 'left_family' })
    expect(mocks.deleteUserMock).toHaveBeenCalledWith(ME)
  })

  it('Storage list 失敗で STORAGE_DELETE_FAILED', async () => {
    mocks.getUserMock.mockResolvedValue({
      data: { user: { id: ME, email: 'me@example.com', identities: [] } },
    })
    mocks.familyMembersResult.mockResolvedValue({
      data: [{ user_id: ME, role: 'admin' }],
      error: null,
    })
    mocks.storageListResult.mockResolvedValue({
      data: null,
      error: { message: 'disk down' },
    })
    const res = await deleteMyAccount({ confirmText: 'DELETE' })
    expect(res).toEqual({ ok: false, code: 'STORAGE_DELETE_FAILED' })
  })

  it('auth.admin.deleteUser が user_not_found なら成功扱い (idempotent)', async () => {
    mocks.getUserMock.mockResolvedValue({
      data: { user: { id: ME, email: 'me@example.com', identities: [] } },
    })
    mocks.familyMembersResult.mockResolvedValue({
      data: [{ user_id: ME, role: 'admin' }],
      error: null,
    })
    mocks.deleteUserMock.mockResolvedValue({
      data: null,
      error: { message: 'User not found' },
    })
    const res = await deleteMyAccount({ confirmText: 'DELETE' })
    expect(res).toEqual({ ok: true, case: 'family_deleted' })
  })

  it('auth.admin.deleteUser が他エラーなら AUTH_DELETE_FAILED', async () => {
    mocks.getUserMock.mockResolvedValue({
      data: { user: { id: ME, email: 'me@example.com', identities: [] } },
    })
    mocks.familyMembersResult.mockResolvedValue({
      data: [{ user_id: ME, role: 'admin' }],
      error: null,
    })
    mocks.deleteUserMock.mockResolvedValue({
      data: null,
      error: { message: 'internal error' },
    })
    const res = await deleteMyAccount({ confirmText: 'DELETE' })
    expect(res).toEqual({ ok: false, code: 'AUTH_DELETE_FAILED' })
  })

  it('notify-mail body に email / user_id が含まれない (PII 漏えい防止)', async () => {
    mocks.getUserMock.mockResolvedValue({
      data: { user: { id: ME, email: 'me@example.com', identities: [] } },
    })
    mocks.familyMembersResult.mockResolvedValue({
      data: [{ user_id: ME, role: 'admin' }],
      error: null,
    })
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'))
    global.fetch = fetchMock as unknown as typeof fetch
    await deleteMyAccount({ confirmText: 'DELETE' })
    expect(fetchMock).toHaveBeenCalled()
    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as { body: string }).body,
    )
    expect(body.email).toBeUndefined()
    expect(body.user_id).toBeUndefined()
    expect(body.family_id).toBe(FAMILY_ID)
  })
})
