/**
 * Tests for guestAiGate helper.
 *
 * Verifies:
 *   - Turnstile failure → 403 TURNSTILE_FAILED (limit not consumed)
 *   - Limit exhausted → 401 AI_LIMIT_GUEST with loginUrl
 *   - Gate order: Turnstile first, then limit
 *   - Pass-through: both checks succeed → { ok: true }
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- hoisted mocks ----
const { verifyTurnstileMock, guestAiLimitMock } = vi.hoisted(() => ({
  verifyTurnstileMock: vi.fn(),
  guestAiLimitMock: vi.fn(),
}))

vi.mock('@/lib/turnstile', () => ({
  verifyTurnstile: (...args: unknown[]) => verifyTurnstileMock(...args),
}))

vi.mock('@/lib/ratelimit', () => ({
  guestAiLimit: { limit: (...args: unknown[]) => guestAiLimitMock(...args) },
}))

// server-only stub
vi.mock('server-only', () => ({}))

import { guestAiGate } from '@/lib/guest-gate'

beforeEach(() => {
  verifyTurnstileMock.mockResolvedValue({ ok: true })
  guestAiLimitMock.mockResolvedValue({ success: true, remaining: 1, reset: 0 })
})

describe('guestAiGate — Turnstile failure', () => {
  it('returns 403 TURNSTILE_FAILED when Turnstile rejects', async () => {
    verifyTurnstileMock.mockResolvedValue({ ok: false, reason: 'invalid-input-response' })

    const result = await guestAiGate({ token: 'bad-token', ip: '1.2.3.4' })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(403)
      const body = await result.response.json() as { error: string }
      expect(body.error).toBe('TURNSTILE_FAILED')
    }
  })

  it('returns 403 TURNSTILE_FAILED when token is undefined', async () => {
    // token: undefined is coerced to '' before passing to verifyTurnstile,
    // which returns { ok: false } when no secret is set AND no token given.
    verifyTurnstileMock.mockResolvedValue({ ok: false, reason: 'no_token' })

    const result = await guestAiGate({ token: undefined, ip: '1.2.3.4' })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(403)
      const body = await result.response.json() as { error: string }
      expect(body.error).toBe('TURNSTILE_FAILED')
    }
  })

  it('does not consume a limit slot when Turnstile fails', async () => {
    verifyTurnstileMock.mockResolvedValue({ ok: false, reason: 'timeout-or-duplicate' })

    await guestAiGate({ token: 'bad-token', ip: '1.2.3.4' })

    expect(guestAiLimitMock).not.toHaveBeenCalled()
  })
})

describe('guestAiGate — limit exhausted', () => {
  it('returns 401 AI_LIMIT_GUEST when limit is consumed', async () => {
    guestAiLimitMock.mockResolvedValue({ success: false, remaining: 0, reset: Date.now() + 5000 })

    const result = await guestAiGate({ token: 'ok-token', ip: '2.3.4.5' })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(401)
      const body = await result.response.json() as { error: string; loginUrl: string }
      expect(body.error).toBe('AI_LIMIT_GUEST')
      expect(body.loginUrl).toContain('/login')
    }
  })

  it('includes the referer in the loginUrl next param', async () => {
    guestAiLimitMock.mockResolvedValue({ success: false, remaining: 0, reset: Date.now() + 5000 })

    const result = await guestAiGate({
      token: 'ok-token',
      ip: '2.3.4.5',
      referer: 'https://example.com/templates/new',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      const body = await result.response.json() as { loginUrl: string }
      expect(body.loginUrl).toContain('next=')
    }
  })
})

describe('guestAiGate — pass-through', () => {
  it('returns { ok: true } when Turnstile passes and limit has remaining quota', async () => {
    const result = await guestAiGate({ token: 'valid-token', ip: '3.4.5.6' })

    expect(result.ok).toBe(true)
  })

  it('calls Turnstile with the supplied token and ip', async () => {
    await guestAiGate({ token: 'my-token', ip: '10.0.0.1' })

    expect(verifyTurnstileMock).toHaveBeenCalledWith('my-token', '10.0.0.1')
  })

  it('calls limit with ip-prefixed key', async () => {
    await guestAiGate({ token: 'ok', ip: '5.5.5.5' })

    expect(guestAiLimitMock).toHaveBeenCalledWith('ip:5.5.5.5')
  })
})
