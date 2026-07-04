// @vitest-environment node
/**
 * Verifies that STATIC_FILE_EXT includes .otf, so the preview-font-loader's
 * `/fonts/NotoSansJP-Regular.subset.otf` fetch is never redirected to /login for guests.
 * Without this, AdjustView's canvas preview silently degrades to the ctx.measureText
 * fallback (wrap position drifts from the PDF output) for every unauthenticated visitor.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn().mockReturnValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: null } }),
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
    },
    cookies: {},
  }),
}))

vi.mock('@/lib/jwt-claims', () => ({
  decodeAccessTokenClaims: vi.fn().mockReturnValue(null),
}))

vi.mock('@/lib/ratelimit', () => ({
  ipBurstLimit: { limit: vi.fn().mockResolvedValue({ success: true, reset: 0, remaining: 10 }) },
}))

vi.mock('@/lib/client-ip', () => ({
  getClientIp: vi.fn().mockReturnValue('1.2.3.4'),
}))

vi.mock('@/lib/cors', () => ({
  resolveAllowedOrigin: vi.fn().mockReturnValue(null),
}))

vi.mock('server-only', () => ({}))

function makeReq(pathname: string): NextRequest {
  return new NextRequest(
    new Request(new URL(pathname, 'http://localhost:3000').toString(), {
      method: 'GET',
      headers: new Headers({ 'x-forwarded-for': '1.2.3.4' }),
    }),
  )
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'test-key'
})

import { middleware } from '@/middleware'

describe('middleware STATIC_FILE_EXT — .otf', () => {
  it('/fonts/NotoSansJP-Regular.subset.otf は未ログインでも通過する（/login リダイレクトなし）', async () => {
    const res = await middleware(makeReq('/fonts/NotoSansJP-Regular.subset.otf'))
    expect(res.status).not.toBe(307)
    expect(res.status).not.toBe(401)
  })

  it('.woff2 は既存どおり通過する（回帰確認）', async () => {
    const res = await middleware(makeReq('/fonts/example.woff2'))
    expect(res.status).not.toBe(307)
    expect(res.status).not.toBe(401)
  })

  it('.otf に見えない保護パスは引き続きリダイレクトされる（誤って全開放していないことの確認）', async () => {
    const res = await middleware(makeReq('/minutes'))
    expect(res.status).toBe(307)
  })
})
