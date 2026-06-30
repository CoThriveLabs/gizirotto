/**
 * Guest AI gate tests for:
 *   POST /api/minutes/format-item
 *   POST /api/minutes/chat/stream
 *
 * Covers: Turnstile gate (S2-1), rate-limit gate, and authenticated bypass.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- shared mock state --------------------------------------------------
const getUserMock = vi.fn()
const guestLimitMock = vi.fn()
const verifyTurnstileMock = vi.fn()

// Supabase server client mock
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      auth: { getUser: getUserMock },
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: new Error('not found') }) }) }) }),
    }),
}))

// Service client mock (used in chat/stream for guest template fetch)
vi.mock('@/lib/supabase/service', () => ({
  createSupabaseServiceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data: { fields: { fields: [{ name: 'agenda', label: '議題' }] } },
              error: null,
            }),
        }),
      }),
    }),
  }),
}))

// ratelimit mock — guestAiLimit only; ipBurstLimit stays noop
vi.mock('@/lib/ratelimit', () => ({
  ipBurstLimit: { limit: async () => ({ success: true, reset: 0, remaining: 10 }) },
  guestAiLimit: { limit: (...args: unknown[]) => guestLimitMock(...args) },
}))

// ai-usage-guard mock (not called for guests)
vi.mock('@/lib/ai-usage-guard', () => ({
  checkAiUsage: vi.fn().mockResolvedValue({ exceeded: false }),
  aiLimitExceededBody: vi.fn(),
  logAiUsage: vi.fn(),
  resolveFamilyIdByUser: vi.fn().mockResolvedValue('family-uuid'),
}))

// Anthropic mock
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      stream: () =>
        // minimal async iterable that never yields events (stream terminates immediately)
        (async function* () {})(),
    }
  },
}))

// server-only guard
vi.mock('server-only', () => ({}))

// Turnstile verification mock
vi.mock('@/lib/turnstile', () => ({
  verifyTurnstile: (...args: unknown[]) => verifyTurnstileMock(...args),
}))

// format-item prompt helpers
vi.mock('@/lib/ai/prompts/format-item', () => ({
  SYSTEM_PROMPT_FORMAT_ITEM: 'sys',
  buildUserPromptFormatItem: () => 'user',
  buildCustomToneInstruction: () => 'custom',
  TONE_INSTRUCTIONS: { omakase: 'omakase', calm: 'calm', polite: 'polite', bright: 'bright' },
}))

// SSE error helper
vi.mock('@/lib/api/error-response', () => ({
  formatSseErrorPayload: (e: unknown) => ({ type: 'error', message: String(e) }),
}))

// builtin-ids mock — only the first three zero-UUIDs are builtin
vi.mock('@/lib/templates/builtin-ids', () => ({
  isBuiltinTemplate: (id: string) =>
    [
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
      '00000000-0000-0000-0000-000000000003',
    ].includes(id),
}))

// guest-metrics mock (best-effort, must not affect response)
vi.mock('@/lib/guest-metrics', () => ({
  recordGuestAiUsage: vi.fn().mockResolvedValue(undefined),
}))

// chat prompts
vi.mock('@/lib/ai/prompts/chat-a1', () => ({
  SYSTEM_PROMPT_CHAT_A1: 'chat-a1-sys',
  buildSystemA1Suffix: () => 'a1-suffix',
}))
vi.mock('@/lib/ai/prompts/chat-a2', () => ({
  SYSTEM_PROMPT_CHAT_A2: 'chat-a2-sys',
  buildSystemA2Suffix: () => 'a2-suffix',
}))

// -----------------------------------------------------------------------

function makeFormatItemRequest(body?: Record<string, unknown>) {
  return new Request('http://localhost/api/minutes/format-item', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' },
    body: JSON.stringify({
      field_name: '議題',
      raw_text: 'テスト',
      tone: 'omakase',
      ...body,
    }),
  })
}

function makeChatStreamRequest(body?: Record<string, unknown>) {
  return new Request('http://localhost/api/minutes/chat/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' },
    body: JSON.stringify({
      session_id: '00000000-0000-0000-0000-000000000099',
      mode: 'A-1',
      template_id: '00000000-0000-0000-0000-000000000001',
      history: [],
      latest_user_message: 'こんにちは',
      ...body,
    }),
  })
}

// -----------------------------------------------------------------------

describe('/api/minutes/format-item — Turnstile gate (S2-1)', () => {
  beforeEach(() => {
    vi.resetModules()
    getUserMock.mockReset()
    guestLimitMock.mockReset()
    verifyTurnstileMock.mockReset()
    getUserMock.mockResolvedValue({ data: { user: null } })
  })

  it('Turnstile 検証失敗 → 403 TURNSTILE_FAILED、guestAiLimit は呼ばれない', async () => {
    verifyTurnstileMock.mockResolvedValue({ ok: false, reason: 'invalid-input-response' })
    const { POST } = await import('@/app/api/minutes/format-item/route')
    const res = await POST(makeFormatItemRequest({ turnstileToken: 'bad-token' }))
    expect(res.status).toBe(403)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('TURNSTILE_FAILED')
    // quota must not be consumed when Turnstile fails
    expect(guestLimitMock).not.toHaveBeenCalled()
  })

  it('Turnstile 検証成功 → quota フローへ進む', async () => {
    verifyTurnstileMock.mockResolvedValue({ ok: true })
    guestLimitMock.mockResolvedValue({ success: true, remaining: 1, reset: 0 })
    const { POST } = await import('@/app/api/minutes/format-item/route')
    const res = await POST(makeFormatItemRequest({ turnstileToken: 'good-token' }))
    expect(res.status).not.toBe(403)
    expect(guestLimitMock).toHaveBeenCalled()
  })

  it('secret 未設定（ok:true reason:skipped_no_secret）→ 通過', async () => {
    verifyTurnstileMock.mockResolvedValue({ ok: true, reason: 'skipped_no_secret' })
    guestLimitMock.mockResolvedValue({ success: true, remaining: 1, reset: 0 })
    const { POST } = await import('@/app/api/minutes/format-item/route')
    const res = await POST(makeFormatItemRequest())
    expect(res.status).not.toBe(403)
  })

  it('ログイン済み → verifyTurnstile が呼ばれない', async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: 'user-uuid' } } })
    verifyTurnstileMock.mockResolvedValue({ ok: false })
    const { POST } = await import('@/app/api/minutes/format-item/route')
    await POST(makeFormatItemRequest())
    expect(verifyTurnstileMock).not.toHaveBeenCalled()
  })
})

describe('/api/minutes/format-item — guest rate-limit', () => {
  beforeEach(() => {
    vi.resetModules()
    getUserMock.mockReset()
    guestLimitMock.mockReset()
    verifyTurnstileMock.mockReset()
    getUserMock.mockResolvedValue({ data: { user: null } })
    // default: Turnstile passes
    verifyTurnstileMock.mockResolvedValue({ ok: true })
  })

  it('ゲストで quota が残っている場合は 401 を返さない（SSE stream が始まる = 200）', async () => {
    guestLimitMock.mockResolvedValue({ success: true, remaining: 1, reset: 0 })
    const { POST } = await import('@/app/api/minutes/format-item/route')
    const res = await POST(makeFormatItemRequest())
    // AI_NOT_CONFIGURED (env なし) か stream が返るが、401 でないことを確認
    expect(res.status).not.toBe(401)
  })

  it('ゲストで quota 超過の場合は 401 + AI_LIMIT_GUEST を返す', async () => {
    guestLimitMock.mockResolvedValue({ success: false, remaining: 0, reset: Date.now() + 1000 })
    const { POST } = await import('@/app/api/minutes/format-item/route')
    const res = await POST(makeFormatItemRequest())
    expect(res.status).toBe(401)
    const body = await res.json() as { error: string; loginUrl: string }
    expect(body.error).toBe('AI_LIMIT_GUEST')
    expect(body.loginUrl).toContain('/login')
  })

  it('ゲスト時の limit キーは "ip:1.2.3.4" を使う', async () => {
    guestLimitMock.mockResolvedValue({ success: false, remaining: 0, reset: 0 })
    const { POST } = await import('@/app/api/minutes/format-item/route')
    await POST(makeFormatItemRequest())
    expect(guestLimitMock).toHaveBeenCalledWith('ip:1.2.3.4')
  })

  it('x-forwarded-for が無い場合は "ip:anonymous" を使う', async () => {
    guestLimitMock.mockResolvedValue({ success: false, remaining: 0, reset: 0 })
    const { POST } = await import('@/app/api/minutes/format-item/route')
    await POST(
      new Request('http://localhost/api/minutes/format-item', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ field_name: '議題', raw_text: 'テスト', tone: 'omakase' }),
      }),
    )
    expect(guestLimitMock).toHaveBeenCalledWith('ip:anonymous')
  })

  it('ログイン済みの場合は guestAiLimit を呼ばない', async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: 'user-uuid' } } })
    guestLimitMock.mockResolvedValue({ success: true, remaining: 2, reset: 0 })
    const { POST } = await import('@/app/api/minutes/format-item/route')
    await POST(makeFormatItemRequest())
    expect(guestLimitMock).not.toHaveBeenCalled()
  })
})

describe('/api/minutes/chat/stream — Turnstile gate (S2-1)', () => {
  beforeEach(() => {
    vi.resetModules()
    getUserMock.mockReset()
    guestLimitMock.mockReset()
    verifyTurnstileMock.mockReset()
    getUserMock.mockResolvedValue({ data: { user: null } })
  })

  it('Turnstile 検証失敗 → 403 TURNSTILE_FAILED、guestAiLimit は呼ばれない', async () => {
    verifyTurnstileMock.mockResolvedValue({ ok: false, reason: 'invalid-input-response' })
    const { POST } = await import('@/app/api/minutes/chat/stream/route')
    const res = await POST(makeChatStreamRequest({ turnstileToken: 'bad-token' }))
    expect(res.status).toBe(403)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('TURNSTILE_FAILED')
    expect(guestLimitMock).not.toHaveBeenCalled()
  })

  it('Turnstile 検証成功 → quota フローへ進む', async () => {
    verifyTurnstileMock.mockResolvedValue({ ok: true })
    guestLimitMock.mockResolvedValue({ success: true, remaining: 1, reset: 0 })
    const { POST } = await import('@/app/api/minutes/chat/stream/route')
    const res = await POST(makeChatStreamRequest({ turnstileToken: 'good-token' }))
    expect(res.status).not.toBe(403)
    expect(guestLimitMock).toHaveBeenCalled()
  })

  it('secret 未設定（ok:true reason:skipped_no_secret）→ 通過', async () => {
    verifyTurnstileMock.mockResolvedValue({ ok: true, reason: 'skipped_no_secret' })
    guestLimitMock.mockResolvedValue({ success: true, remaining: 1, reset: 0 })
    const { POST } = await import('@/app/api/minutes/chat/stream/route')
    const res = await POST(makeChatStreamRequest())
    expect(res.status).not.toBe(403)
  })

  it('ログイン済み → verifyTurnstile が呼ばれない', async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: 'user-uuid' } } })
    verifyTurnstileMock.mockResolvedValue({ ok: false })
    const { POST } = await import('@/app/api/minutes/chat/stream/route')
    await POST(makeChatStreamRequest())
    expect(verifyTurnstileMock).not.toHaveBeenCalled()
  })
})

describe('/api/minutes/chat/stream — guest rate-limit', () => {
  beforeEach(() => {
    vi.resetModules()
    getUserMock.mockReset()
    guestLimitMock.mockReset()
    verifyTurnstileMock.mockReset()
    getUserMock.mockResolvedValue({ data: { user: null } })
    // default: Turnstile passes
    verifyTurnstileMock.mockResolvedValue({ ok: true })
  })

  it('ゲストで quota 超過の場合は 401 + AI_LIMIT_GUEST を返す', async () => {
    guestLimitMock.mockResolvedValue({ success: false, remaining: 0, reset: Date.now() + 1000 })
    const { POST } = await import('@/app/api/minutes/chat/stream/route')
    const res = await POST(makeChatStreamRequest())
    expect(res.status).toBe(401)
    const body = await res.json() as { error: string; loginUrl: string }
    expect(body.error).toBe('AI_LIMIT_GUEST')
    expect(body.loginUrl).toContain('/login')
  })

  it('ゲストで quota が残っている場合 template 取得まで進む（stream or 404）', async () => {
    // template maybeSingle returns null → 404 TEMPLATE_NOT_FOUND
    guestLimitMock.mockResolvedValue({ success: true, remaining: 1, reset: 0 })
    const { POST } = await import('@/app/api/minutes/chat/stream/route')
    const res = await POST(makeChatStreamRequest())
    // Either 404 (template mock returns null) or non-401, never 401
    expect(res.status).not.toBe(401)
  })

  it('ゲスト時の limit キーは "ip:1.2.3.4" を使う', async () => {
    guestLimitMock.mockResolvedValue({ success: false, remaining: 0, reset: 0 })
    const { POST } = await import('@/app/api/minutes/chat/stream/route')
    await POST(makeChatStreamRequest())
    expect(guestLimitMock).toHaveBeenCalledWith('ip:1.2.3.4')
  })

  it('ログイン済みの場合は guestAiLimit を呼ばない', async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: 'user-uuid' } } })
    guestLimitMock.mockResolvedValue({ success: true, remaining: 2, reset: 0 })
    const { POST } = await import('@/app/api/minutes/chat/stream/route')
    await POST(makeChatStreamRequest())
    expect(guestLimitMock).not.toHaveBeenCalled()
  })
})

describe('/api/minutes/chat/stream — builtin template guard', () => {
  beforeEach(() => {
    vi.resetModules()
    getUserMock.mockReset()
    guestLimitMock.mockReset()
    verifyTurnstileMock.mockReset()
    getUserMock.mockResolvedValue({ data: { user: null } })
    verifyTurnstileMock.mockResolvedValue({ ok: true })
    // quota: always passes so we reach the template guard
    guestLimitMock.mockResolvedValue({ success: true, remaining: 1, reset: 0 })
  })

  it('非 builtin template_id → 403 TEMPLATE_NOT_ALLOWED', async () => {
    const { POST } = await import('@/app/api/minutes/chat/stream/route')
    const res = await POST(
      makeChatStreamRequest({ template_id: 'aaaaaaaa-0000-0000-0000-000000000099' }),
    )
    expect(res.status).toBe(403)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('TEMPLATE_NOT_ALLOWED')
  })

  it('builtin template_id → TEMPLATE_NOT_ALLOWED は返さない', async () => {
    const { POST } = await import('@/app/api/minutes/chat/stream/route')
    const res = await POST(
      makeChatStreamRequest({ template_id: '00000000-0000-0000-0000-000000000001' }),
    )
    // 403 TEMPLATE_NOT_ALLOWED でないことを確認（404 or stream が返る）
    expect(res.status).not.toBe(403)
  })

  it('AI_LIMIT_GUEST レスポンスに loginUrl が含まれる', async () => {
    guestLimitMock.mockResolvedValue({ success: false, remaining: 0, reset: Date.now() + 1000 })
    const { POST } = await import('@/app/api/minutes/chat/stream/route')
    const req = new Request('http://localhost/api/minutes/chat/stream', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '1.2.3.4',
        referer: 'http://localhost/minutes/new/chat?templateId=00000000-0000-0000-0000-000000000001',
      },
      body: JSON.stringify({
        session_id: '00000000-0000-0000-0000-000000000099',
        mode: 'A-1',
        template_id: '00000000-0000-0000-0000-000000000001',
        history: [],
        latest_user_message: 'こんにちは',
      }),
    })
    const res = await POST(req)
    expect(res.status).toBe(401)
    const body = await res.json() as { error: string; loginUrl: string }
    expect(body.error).toBe('AI_LIMIT_GUEST')
    expect(body.loginUrl).toContain('/login')
    expect(body.loginUrl).toContain('next=')
  })
})
