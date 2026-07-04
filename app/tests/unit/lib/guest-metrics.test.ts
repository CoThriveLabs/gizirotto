import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { recordGuestAiUsage } from '@/lib/guest-metrics'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setUpstashEnv(url: string, token: string) {
  vi.stubEnv('UPSTASH_REDIS_REST_URL', url)
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', token)
}

function clearUpstashEnv() {
  vi.stubEnv('UPSTASH_REDIS_REST_URL', '')
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '')
}

// ---------------------------------------------------------------------------
// recordGuestAiUsage — no Upstash env → no-op
// ---------------------------------------------------------------------------

describe('recordGuestAiUsage — no Upstash env', () => {
  beforeEach(() => {
    clearUpstashEnv()
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('does not call fetch when env vars are absent', async () => {
    await recordGuestAiUsage({
      endpoint: 'chat-stream',
      inputTokens: 100,
      outputTokens: 50,
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// recordGuestAiUsage — Upstash env present
// ---------------------------------------------------------------------------

describe('recordGuestAiUsage — Upstash env present', () => {
  const FAKE_URL = 'https://upstash.example.com'
  const FAKE_TOKEN = 'test-token-abc'

  beforeEach(() => {
    setUpstashEnv(FAKE_URL, FAKE_TOKEN)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('POSTs to the pipeline endpoint', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)

    await recordGuestAiUsage({
      endpoint: 'chat-stream',
      inputTokens: 200,
      outputTokens: 80,
    })

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${FAKE_URL}/pipeline`)
    expect(init.method).toBe('POST')
  })

  it('includes HINCRBY and EXPIRE commands in the request body', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)

    await recordGuestAiUsage({
      endpoint: 'format-item',
      inputTokens: 300,
      outputTokens: 120,
    })

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as unknown[][]
    const commands = body.map((cmd) => cmd[0])
    expect(commands).toContain('HINCRBY')
    expect(commands).toContain('EXPIRE')
  })

  it("includes today's date (YYYY-MM-DD) in the Redis key", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)

    await recordGuestAiUsage({
      endpoint: 'chat-stream',
      inputTokens: 10,
      outputTokens: 5,
    })

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as unknown[][]
    const today = new Date().toISOString().slice(0, 10)
    // The key is the second element of each command that references it.
    const keys = body.map((cmd) => cmd[1]).filter((k) => typeof k === 'string')
    expect(keys.some((k) => (k as string).includes(today))).toBe(true)
  })

  it('does not throw when fetch rejects (best-effort)', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('network failure'))
    vi.stubGlobal('fetch', mockFetch)

    await expect(
      recordGuestAiUsage({
        endpoint: 'chat-stream',
        inputTokens: 10,
        outputTokens: 5,
      }),
    ).resolves.toBeUndefined()
  })
})
