/**
 * Tests for guestTemplateLimit in ratelimit.ts.
 * Verifies prefix isolation from guestAiDailyLimit and noop behaviour in non-production.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

// capturedPrefixes must be declared via vi.hoisted so that the vi.mock factory
// (which is hoisted to the top of the module) can access it at initialisation time.
const { capturedPrefixes } = vi.hoisted(() => {
  const capturedPrefixes: string[] = []
  return { capturedPrefixes }
})

vi.mock('@upstash/ratelimit', () => ({
  Ratelimit: class {
    constructor(opts: { prefix?: string }) {
      if (opts.prefix) capturedPrefixes.push(opts.prefix)
    }
    static slidingWindow() { return {} }
    async limit() { return { success: true, reset: 0, remaining: 10 } }
  },
}))
vi.mock('@upstash/redis', () => ({
  Redis: { fromEnv: () => ({}) },
}))

const originalEnv = { ...process.env }

afterEach(() => {
  vi.unstubAllEnvs()
  Object.assign(process.env, originalEnv)
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key]
    }
  }
  vi.resetModules()
  capturedPrefixes.length = 0
})

function clearUpstashEnv() {
  delete process.env.UPSTASH_REDIS_REST_URL
  delete process.env.UPSTASH_REDIS_REST_TOKEN
}

function setUpstashEnv() {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io'
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token'
}

describe('guestTemplateLimit', () => {
  it('resolves to noop in non-production (no Upstash env)', async () => {
    clearUpstashEnv()
    vi.stubEnv('VERCEL_ENV', '')
    vi.stubEnv('NODE_ENV', 'test')

    const mod = await import('@/lib/ratelimit')
    const result = await mod.guestTemplateLimit.limit('ip:test')
    expect(result.success).toBe(true)
    expect(typeof result.reset).toBe('number')
    expect(typeof result.remaining).toBe('number')
  })

  it('uses a different prefix than guestAiDailyLimit (key space isolation)', async () => {
    setUpstashEnv()
    vi.stubEnv('VERCEL_ENV', '')

    await import('@/lib/ratelimit')

    // Both limiters must be registered with distinct key-space prefixes.
    expect(capturedPrefixes).toContain('minutes:guest-template')
    expect(capturedPrefixes).toContain('minutes:guest-ai-daily')
    // The two prefixes must be different strings (not deduplicated).
    expect(capturedPrefixes.indexOf('minutes:guest-template')).not.toBe(
      capturedPrefixes.indexOf('minutes:guest-ai-daily'),
    )
  })

  it('exports guestTemplateLimit as a RateLimiter (has .limit method)', async () => {
    clearUpstashEnv()
    vi.stubEnv('VERCEL_ENV', '')
    vi.stubEnv('NODE_ENV', 'test')

    const mod = await import('@/lib/ratelimit')
    expect(typeof mod.guestTemplateLimit.limit).toBe('function')
  })
})
