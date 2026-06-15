import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

describe('/api/ping route handler', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.restoreAllMocks()
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('returns 401 when PING_SECRET is set but Authorization missing', async () => {
    process.env.PING_SECRET = 'topsecret'
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    const { GET } = await import('@/app/api/ping/route')
    const res = await GET(new Request('http://localhost/api/ping'))
    expect(res.status).toBe(401)
  })

  it('returns 200 with correct Authorization header', async () => {
    process.env.PING_SECRET = 'topsecret'
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    const { GET } = await import('@/app/api/ping/route')
    const res = await GET(
      new Request('http://localhost/api/ping', {
        headers: { authorization: 'Bearer topsecret' },
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.runtime).toBe('edge')
    expect(typeof body.ts).toBe('string')
  })

  it('skips auth when PING_SECRET unset (local dev)', async () => {
    delete process.env.PING_SECRET
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    const { GET } = await import('@/app/api/ping/route')
    const res = await GET(new Request('http://localhost/api/ping'))
    expect(res.status).toBe(200)
  })

  it('declares edge runtime', async () => {
    const mod = await import('@/app/api/ping/route')
    expect(mod.runtime).toBe('edge')
  })
})
