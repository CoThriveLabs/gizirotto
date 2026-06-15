import { describe, it, expect, vi, beforeEach } from 'vitest'

const exchangeCodeForSession = vi.fn()
const verifyOtp = vi.fn()

vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [] }),
}))

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      exchangeCodeForSession,
      verifyOtp,
    },
  }),
}))

import { GET } from '@/app/auth/callback/route'

function makeRequest(query: string): Request {
  return new Request(`http://localhost:3000/auth/callback${query}`)
}

function locationOf(res: Response): string {
  return res.headers.get('location') ?? ''
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'test-key'
})

describe('auth/callback GET — code (PKCE / magic link) 経路', () => {
  it('?code=xxx 成功時は next にリダイレクトする', async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null })
    const res = await GET(makeRequest('?code=abc&next=/reset-password'))
    expect(exchangeCodeForSession).toHaveBeenCalledWith('abc')
    expect(verifyOtp).not.toHaveBeenCalled()
    expect(locationOf(res)).toBe('http://localhost:3000/reset-password')
  })

  it('next 未指定なら / にリダイレクトする', async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null })
    const res = await GET(makeRequest('?code=abc'))
    expect(locationOf(res)).toBe('http://localhost:3000/')
  })

  it('?code=xxx 失敗時は login?error=auth_callback_failed にフォールバック', async () => {
    exchangeCodeForSession.mockResolvedValue({ error: { message: 'bad code' } })
    const res = await GET(makeRequest('?code=bad&next=/reset-password'))
    expect(locationOf(res)).toBe('http://localhost:3000/login?error=auth_callback_failed')
  })
})

describe('auth/callback GET — token_hash (recovery) 経路', () => {
  it('?token_hash=xxx&type=recovery 成功時は next にリダイレクトする', async () => {
    verifyOtp.mockResolvedValue({ error: null })
    const res = await GET(
      makeRequest('?token_hash=pkce_hash&type=recovery&next=/reset-password'),
    )
    expect(verifyOtp).toHaveBeenCalledWith({ type: 'recovery', token_hash: 'pkce_hash' })
    expect(exchangeCodeForSession).not.toHaveBeenCalled()
    expect(locationOf(res)).toBe('http://localhost:3000/reset-password')
  })

  it('?token_hash=xxx&type=recovery 失敗時は login にフォールバック', async () => {
    verifyOtp.mockResolvedValue({ error: { message: 'expired' } })
    const res = await GET(makeRequest('?token_hash=bad&type=recovery&next=/reset-password'))
    expect(locationOf(res)).toBe('http://localhost:3000/login?error=auth_callback_failed')
  })

  it('未知の type は OTP 経路に入らずフォールバックする', async () => {
    const res = await GET(makeRequest('?token_hash=h&type=bogus'))
    expect(verifyOtp).not.toHaveBeenCalled()
    expect(exchangeCodeForSession).not.toHaveBeenCalled()
    expect(locationOf(res)).toBe('http://localhost:3000/login?error=auth_callback_failed')
  })

  it('type 欠落（token_hash のみ）はフォールバックする', async () => {
    const res = await GET(makeRequest('?token_hash=h'))
    expect(verifyOtp).not.toHaveBeenCalled()
    expect(locationOf(res)).toBe('http://localhost:3000/login?error=auth_callback_failed')
  })
})

describe('auth/callback GET — パラメータ無し', () => {
  it('code も token_hash も無ければ login にフォールバックする', async () => {
    const res = await GET(makeRequest(''))
    expect(verifyOtp).not.toHaveBeenCalled()
    expect(exchangeCodeForSession).not.toHaveBeenCalled()
    expect(locationOf(res)).toBe('http://localhost:3000/login?error=auth_callback_failed')
  })
})
