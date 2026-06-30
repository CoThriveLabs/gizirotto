/**
 * Tests for the production fail-safe in ratelimit.ts.
 *
 * The module throws at initialisation time when Upstash env vars are missing
 * in a production runtime, ensuring misconfigured deployments surface immediately
 * rather than silently passing all requests through.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

// Preserve original env to restore after each test
const originalEnv = { ...process.env }

afterEach(() => {
  // Restore any vi.stubEnv overrides (includes NODE_ENV)
  vi.unstubAllEnvs()
  // Restore env and clear module registry so next test gets a fresh import
  Object.assign(process.env, originalEnv)
  // Remove keys that were added during the test
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key]
    }
  }
  vi.resetModules()
})

function clearUpstashEnv() {
  delete process.env.UPSTASH_REDIS_REST_URL
  delete process.env.UPSTASH_REDIS_REST_TOKEN
}

function setUpstashEnv() {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io'
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token'
}

describe('ratelimit fail-safe', () => {
  it('throws at module init when production + no Upstash env', async () => {
    clearUpstashEnv()
    process.env.VERCEL_ENV = 'production'

    await expect(import('@/lib/ratelimit')).rejects.toThrow('RATELIMIT_MISCONFIGURED')
  })

  it('does NOT throw when production + Upstash env present', async () => {
    setUpstashEnv()
    process.env.VERCEL_ENV = 'production'

    // Mock the Upstash clients to avoid real network calls
    vi.mock('@upstash/redis', () => ({
      Redis: { fromEnv: () => ({}) },
    }))
    vi.mock('@upstash/ratelimit', () => ({
      Ratelimit: class {
        static slidingWindow() { return {} }
        limit() { return Promise.resolve({ success: true, reset: 0, remaining: 10 }) }
      },
    }))

    await expect(import('@/lib/ratelimit')).resolves.toBeDefined()
  })

  it('does NOT throw in non-production even without Upstash env', async () => {
    clearUpstashEnv()
    // vi.stubEnv handles NODE_ENV safely (bypasses TypeScript read-only and runtime restrictions)
    vi.stubEnv('VERCEL_ENV', '')
    vi.stubEnv('NODE_ENV', 'test')

    await expect(import('@/lib/ratelimit')).resolves.toBeDefined()
  })

  it('noop limiter returns success:true in non-production', async () => {
    clearUpstashEnv()
    vi.stubEnv('VERCEL_ENV', '')
    vi.stubEnv('NODE_ENV', 'test')

    const mod = await import('@/lib/ratelimit')
    const result = await mod.guestAiLimit.limit('ip:test')
    expect(result.success).toBe(true)
  })
})
