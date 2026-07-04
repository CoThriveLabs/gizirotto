// @vitest-environment node
/**
 * Verifies that the GUEST_API_PATHS allowlist in middleware uses exact pathname
 * matching only — sub-paths and unrelated routes must not be let through.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// Supabase / JWT / ratelimit mocks
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
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' }),
    }),
  )
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'test-key'
})

import { middleware } from '@/middleware'

describe('middleware GUEST_API_PATHS — exact match allowlist', () => {
  it('/api/minutes/chat/stream は通過する（auth リダイレクトなし）', async () => {
    const res = await middleware(makeReq('/api/minutes/chat/stream'))
    // NextResponse.next() returns 200; auth redirect returns 307 or 401 JSON
    expect(res.status).not.toBe(307)
    expect(res.status).not.toBe(401)
  })

  it('/api/minutes/format-item は通過する', async () => {
    const res = await middleware(makeReq('/api/minutes/format-item'))
    expect(res.status).not.toBe(307)
    expect(res.status).not.toBe(401)
  })

  it('/api/minutes/chat/extract-fields は通過する（GA4）', async () => {
    const res = await middleware(makeReq('/api/minutes/chat/extract-fields'))
    expect(res.status).not.toBe(307)
    expect(res.status).not.toBe(401)
  })

  it('/api/minutes/chat/extract-fields/extra はゲスト通過しない（配下パスは完全一致外）', async () => {
    const res = await middleware(makeReq('/api/minutes/chat/extract-fields/extra'))
    expect(res.status).toBe(401)
  })

  it('/api/minutes/chat/stream/extra はゲスト通過しない（配下パスは完全一致外）', async () => {
    const res = await middleware(makeReq('/api/minutes/chat/stream/extra'))
    // Unauthenticated /api/* → 401 JSON (isJsonClient returns true for /api/ paths)
    expect(res.status).toBe(401)
  })

  it('/api/minutes/render-image はゲスト通過しない', async () => {
    const res = await middleware(makeReq('/api/minutes/render-image'))
    expect(res.status).toBe(401)
  })
})
