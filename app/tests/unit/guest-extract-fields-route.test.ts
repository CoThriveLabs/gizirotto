/**
 * POST /api/minutes/chat/extract-fields — guest-only counterpart of the
 * extractFieldsFromChat Server Action.
 *
 * Mocking strategy mirrors tests/unit/guest-ai-limit-route.test.ts: mock the low-level
 * dependencies (verifyTurnstile / guestAiDailyLimit) and let the real guestAiGate run, rather
 * than mocking guestAiGate itself — this exercises the actual gate composition.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const getUserMock = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => Promise.resolve({ auth: { getUser: getUserMock } }),
}))

const verifyTurnstileMock = vi.fn()
vi.mock('@/lib/turnstile', () => ({
  verifyTurnstile: (...args: unknown[]) => verifyTurnstileMock(...args),
}))

const guestAiDailyLimitMock = vi.fn()
vi.mock('@/lib/ratelimit', () => ({
  guestAiDailyLimit: { limit: (...args: unknown[]) => guestAiDailyLimitMock(...args) },
}))

vi.mock('@/lib/client-ip', () => ({
  getClientIp: vi.fn().mockReturnValue('1.2.3.4'),
}))

const getTemplateMock = vi.fn()
vi.mock('@/server/templates', () => ({
  getTemplate: (...args: unknown[]) => getTemplateMock(...args),
}))

const createMock = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: (...args: unknown[]) => createMock(...args),
    }
  },
}))

import { POST } from '@/app/api/minutes/chat/extract-fields/route'

const BUILTIN_ID = '00000000-0000-0000-0000-000000000001'
const NON_BUILTIN_ID = '11111111-1111-1111-1111-111111111111'
const VALID_CONVERSATION = [{ role: 'user' as const, content: 'こんにちは' }]

function makeRequest(body: unknown, extraHeaders: Record<string, string> = {}) {
  return new Request('http://localhost/api/minutes/chat/extract-fields', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '1.2.3.4',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0]
}

beforeEach(() => {
  getUserMock.mockReset()
  verifyTurnstileMock.mockReset()
  guestAiDailyLimitMock.mockReset()
  getTemplateMock.mockReset()
  createMock.mockReset()
  getUserMock.mockResolvedValue({ data: { user: null } })
  verifyTurnstileMock.mockResolvedValue({ ok: true })
  guestAiDailyLimitMock.mockResolvedValue({ success: true, remaining: 1, reset: 0 })
  getTemplateMock.mockResolvedValue({ fields: [{ name: 'attendees', label_ja: '参加者' }] })
  process.env.ANTHROPIC_API_KEY = 'test-key'
  process.env.ANTHROPIC_MODEL = 'test-model'
})

describe('POST /api/minutes/chat/extract-fields', () => {
  it('(d) ログイン済みユーザーからの呼び出しは 403 GUEST_ONLY（Turnstile 検証すら行わない）', async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: 'u1' } } })
    const res = await POST(
      makeRequest({ templateId: BUILTIN_ID, conversation: VALID_CONVERSATION }),
    )
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('GUEST_ONLY')
    expect(verifyTurnstileMock).not.toHaveBeenCalled()
    expect(getTemplateMock).not.toHaveBeenCalled()
  })

  it('(a) Turnstile 検証失敗 → 403 TURNSTILE_FAILED・guestAiDailyLimit は呼ばれない', async () => {
    verifyTurnstileMock.mockResolvedValue({ ok: false, reason: 'invalid-input-response' })
    const res = await POST(
      makeRequest({
        templateId: BUILTIN_ID,
        conversation: VALID_CONVERSATION,
        turnstileToken: 'bad-token',
      }),
    )
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('TURNSTILE_FAILED')
    expect(guestAiDailyLimitMock).not.toHaveBeenCalled()
    expect(getTemplateMock).not.toHaveBeenCalled()
  })

  it('(b) guestAiDailyLimit 到達 → 429 GUEST_AI_DAILY_LIMIT + Retry-After', async () => {
    guestAiDailyLimitMock.mockResolvedValue({
      success: false,
      remaining: 0,
      reset: Date.now() + 1000,
    })
    const res = await POST(
      makeRequest({ templateId: BUILTIN_ID, conversation: VALID_CONVERSATION }),
    )
    expect(res.status).toBe(429)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('GUEST_AI_DAILY_LIMIT')
    // loginUrl は含めない（時間経過で自動復帰）。
    expect((body as Record<string, unknown>).loginUrl).toBeUndefined()
    // Retry-After ヘッダーが乗ること。
    const retryAfter = res.headers.get('Retry-After')
    expect(retryAfter).not.toBeNull()
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1)
    expect(getTemplateMock).not.toHaveBeenCalled()
  })

  it('(c) builtin 以外の templateId は 403 TEMPLATE_NOT_ALLOWED（getTemplate を呼ばない）', async () => {
    const res = await POST(
      makeRequest({ templateId: NON_BUILTIN_ID, conversation: VALID_CONVERSATION }),
    )
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('TEMPLATE_NOT_ALLOWED')
    expect(getTemplateMock).not.toHaveBeenCalled()
  })

  it('(f) fields 空テンプレは早期 return で {values:{}} を返す（Anthropic を呼ばない）', async () => {
    getTemplateMock.mockResolvedValue({ fields: [] })
    const res = await POST(
      makeRequest({ templateId: BUILTIN_ID, conversation: VALID_CONVERSATION }),
    )
    expect(res.status).toBe(200)
    expect((await res.json()).values).toEqual({})
    expect(createMock).not.toHaveBeenCalled()
  })

  it('(e) 正常系: Anthropic tool_use 応答から正しい values を返す', async () => {
    createMock.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          name: 'fill_minute_fields',
          input: { values: { attendees: '田中さん、佐藤さん' } },
        },
      ],
    })
    const res = await POST(
      makeRequest({ templateId: BUILTIN_ID, conversation: VALID_CONVERSATION }),
    )
    expect(res.status).toBe(200)
    expect((await res.json()).values).toEqual({ attendees: '田中さん、佐藤さん' })
  })

  it('クライアント送信の fields は無視され、template から再解決した fields だけが使われる（偽装防止）', async () => {
    createMock.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          name: 'fill_minute_fields',
          input: { values: { attendees: 'x', evil_field: 'y' } },
        },
      ],
    })
    const res = await POST(
      makeRequest({
        templateId: BUILTIN_ID,
        conversation: VALID_CONVERSATION,
        fields: [{ name: 'evil_field', label: '偽装項目' }],
      }),
    )
    const json = (await res.json()) as { values: Record<string, string> }
    expect(Object.keys(json.values)).toEqual(['attendees'])
    expect(json.values.evil_field).toBeUndefined()
  })

  it('templateId が UUID でない場合は 400 INVALID_REQUEST', async () => {
    const res = await POST(
      makeRequest({ templateId: 'not-a-uuid', conversation: VALID_CONVERSATION }),
    )
    expect(res.status).toBe(400)
  })

  it('conversation が空配列だと 400 INVALID_REQUEST（.min(1) 制約）', async () => {
    const res = await POST(makeRequest({ templateId: BUILTIN_ID, conversation: [] }))
    expect(res.status).toBe(400)
  })

  it('ANTHROPIC_API_KEY 未設定時は 500 AI_NOT_CONFIGURED', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const res = await POST(
      makeRequest({ templateId: BUILTIN_ID, conversation: VALID_CONVERSATION }),
    )
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('AI_NOT_CONFIGURED')
  })

  it('Anthropic 呼び出しが例外を投げたら 502 AI_REQUEST_FAILED', async () => {
    createMock.mockRejectedValue(new Error('network error'))
    const res = await POST(
      makeRequest({ templateId: BUILTIN_ID, conversation: VALID_CONVERSATION }),
    )
    expect(res.status).toBe(502)
    expect((await res.json()).error).toBe('AI_REQUEST_FAILED')
  })

  it('tool_use ブロックが無い応答は 502 NO_TOOL_USE_BLOCK', async () => {
    createMock.mockResolvedValue({ content: [{ type: 'text', text: 'oops' }] })
    const res = await POST(
      makeRequest({ templateId: BUILTIN_ID, conversation: VALID_CONVERSATION }),
    )
    expect(res.status).toBe(502)
    expect((await res.json()).error).toBe('NO_TOOL_USE_BLOCK')
  })

  it('ログイン済みの場合は guestAiDailyLimit を呼ばない（早期 403 return の確認）', async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: 'u1' } } })
    await POST(makeRequest({ templateId: BUILTIN_ID, conversation: VALID_CONVERSATION }))
    expect(guestAiDailyLimitMock).not.toHaveBeenCalled()
  })
})
