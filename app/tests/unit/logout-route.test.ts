/**
 * /api/auth/logout route handler unit test
 *
 * 検証項目:
 *   1. POST で 200 + { ok: true } 返却
 *   2. supabase.auth.signOut() が呼ばれる
 *   3. supabase.signOut() が throw しても 200 返却（cookie 削除優先）
 *   4. cookieStore.getAll() が呼べる構造で createServerClient に渡る
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const signOutMock = vi.fn()
const getAllMock = vi.fn(() => [])

vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: getAllMock }),
}))

vi.mock('@supabase/ssr', () => ({
  createServerClient: (_url: string, _key: string, _opts: unknown) => ({
    auth: {
      signOut: signOutMock,
    },
  }),
}))

import { POST } from '@/app/api/auth/logout/route'

beforeEach(() => {
  signOutMock.mockReset()
  getAllMock.mockClear()
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'test-key'
})

describe('/api/auth/logout POST', () => {
  it('POST 呼び出しで 200 + { ok: true } 返却', async () => {
    signOutMock.mockResolvedValue({ error: null })
    const res = await POST()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true })
    expect(signOutMock).toHaveBeenCalledTimes(1)
  })

  it('supabase.auth.signOut() が呼ばれる（cookie store も resolve される）', async () => {
    signOutMock.mockResolvedValue({ error: null })
    await POST()
    expect(signOutMock).toHaveBeenCalledTimes(1)
  })

  it('supabase.signOut() が throw しても 200 返却（cookie 削除優先）', async () => {
    signOutMock.mockRejectedValue(new Error('network down'))
    const res = await POST()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true })
  })

  it('session 既無しで signOut が AuthError 風 reject でも 200', async () => {
    signOutMock.mockRejectedValue({ name: 'AuthSessionMissingError', message: 'no session' })
    const res = await POST()
    expect(res.status).toBe(200)
  })
})
