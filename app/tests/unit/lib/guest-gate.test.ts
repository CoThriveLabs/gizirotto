/**
 * Tests for guestAiGate helper (GA6 スロットル仕様).
 *
 * Verifies:
 *   - Turnstile failure → 403 TURNSTILE_FAILED (limit not consumed)
 *   - Limit exhausted → 429 GUEST_AI_DAILY_LIMIT + Retry-After（ログイン誘導しない）
 *   - Gate order: Turnstile first, then limit
 *   - Pass-through: both checks succeed → { ok: true }
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- hoisted mocks ----
const { verifyTurnstileMock, guestAiDailyLimitMock } = vi.hoisted(() => ({
  verifyTurnstileMock: vi.fn(),
  guestAiDailyLimitMock: vi.fn(),
}))

vi.mock('@/lib/turnstile', () => ({
  verifyTurnstile: (...args: unknown[]) => verifyTurnstileMock(...args),
}))

vi.mock('@/lib/ratelimit', () => ({
  guestAiDailyLimit: { limit: (...args: unknown[]) => guestAiDailyLimitMock(...args) },
}))

// server-only stub
vi.mock('server-only', () => ({}))

import { guestAiGate } from '@/lib/guest-gate'

beforeEach(() => {
  verifyTurnstileMock.mockResolvedValue({ ok: true })
  guestAiDailyLimitMock.mockResolvedValue({ success: true, remaining: 1, reset: 0 })
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

    expect(guestAiDailyLimitMock).not.toHaveBeenCalled()
  })
})

describe('guestAiGate — daily limit exhausted', () => {
  it('returns 429 GUEST_AI_DAILY_LIMIT when limit is consumed', async () => {
    guestAiDailyLimitMock.mockResolvedValue({
      success: false,
      remaining: 0,
      reset: Date.now() + 5000,
    })

    const result = await guestAiGate({ token: 'ok-token', ip: '2.3.4.5' })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.response.status).toBe(429)
      const body = await result.response.json() as { error: string }
      expect(body.error).toBe('GUEST_AI_DAILY_LIMIT')
      // loginUrl は含めない（時間経過で自動復帰するスロットル）。
      expect((body as Record<string, unknown>).loginUrl).toBeUndefined()
    }
  })

  it('includes Retry-After header (seconds >= 1) when limit is exhausted', async () => {
    // reset を過去にセットしても Retry-After は 1 秒未満にならないこと（Math.max(1, ...) 防御）。
    guestAiDailyLimitMock.mockResolvedValue({
      success: false,
      remaining: 0,
      reset: Date.now() - 5000,
    })

    const result = await guestAiGate({ token: 'ok-token', ip: '2.3.4.5' })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      const retryAfter = result.response.headers.get('Retry-After')
      expect(retryAfter).not.toBeNull()
      expect(Number(retryAfter)).toBeGreaterThanOrEqual(1)
    }
  })

  it('Retry-After reflects reset epoch when in the future', async () => {
    const resetMs = Date.now() + 60_000
    guestAiDailyLimitMock.mockResolvedValue({
      success: false,
      remaining: 0,
      reset: resetMs,
    })

    const result = await guestAiGate({ token: 'ok-token', ip: '2.3.4.5' })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      const retryAfter = Number(result.response.headers.get('Retry-After'))
      // 60秒 ±5秒 で妥当性のみ確認（実行時刻の誤差吸収）。
      expect(retryAfter).toBeGreaterThan(50)
      expect(retryAfter).toBeLessThan(65)
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

    expect(guestAiDailyLimitMock).toHaveBeenCalledWith('ip:5.5.5.5')
  })
})
