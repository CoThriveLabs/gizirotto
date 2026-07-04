// @vitest-environment node
/**
 * Verifies the /api/guest/ prefix opening in middleware: the whole prefix must pass
 * through without the auth redirect, while paths that merely resemble the prefix
 * (no trailing slash boundary) or sibling /api/minutes/* routes stay protected.
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

// vi.hoisted so the mock factory (hoisted above imports) can share the same fn reference
// that individual tests reconfigure via mockResolvedValueOnce.
const { ipBurstLimitMock } = vi.hoisted(() => {
  const ipBurstLimitMock = vi.fn().mockResolvedValue({ success: true, reset: 0, remaining: 10 })
  return { ipBurstLimitMock }
})

vi.mock('@/lib/ratelimit', () => ({
  ipBurstLimit: { limit: ipBurstLimitMock },
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
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' }),
    }),
  )
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'test-key'
  // Reset to the default pass-through behaviour so a 429 configured in one test
  // (via mockResolvedValueOnce) never leaks into the next.
  ipBurstLimitMock.mockReset()
  ipBurstLimitMock.mockResolvedValue({ success: true, reset: 0, remaining: 10 })
})

import { middleware } from '@/middleware'

describe('middleware /api/guest/ prefix opening', () => {
  it('/api/guest/render-image はゲスト（未ログイン）でも通過する', async () => {
    const res = await middleware(makeReq('/api/guest/render-image'))
    expect(res.status).not.toBe(307)
    expect(res.status).not.toBe(401)
  })

  it('/api/guest/anything は prefix 開放で同様に通過する', async () => {
    const res = await middleware(makeReq('/api/guest/anything'))
    expect(res.status).not.toBe(307)
    expect(res.status).not.toBe(401)
  })

  it('/api/guestbogus/render-image は prefix 境界外（trailing slash 無し）なのでゲスト通過しない', async () => {
    const res = await middleware(makeReq('/api/guestbogus/render-image'))
    expect(res.status).toBe(401)
  })

  it('/api/minutes/render-image（既存の認証必須 route）は引き続き保護される', async () => {
    const res = await middleware(makeReq('/api/minutes/render-image'))
    expect(res.status).toBe(401)
  })

  it('ipBurstLimit が success:false を返すと /api/guest/render-image でも 429 になる', async () => {
    const resetAt = Date.now() + 5000
    ipBurstLimitMock.mockResolvedValueOnce({ success: false, reset: resetAt, remaining: 0 })
    const res = await middleware(makeReq('/api/guest/render-image'))
    expect(res.status).toBe(429)
    // ipBurstLimit は /api/guest/ prefix 開放より前段で効くため、429 は guest gate 到達前に発生する。
    expect(res.headers.get('Retry-After')).not.toBeNull()
  })
})
