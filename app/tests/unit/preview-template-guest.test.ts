/**
 * Tests for previewTemplateAsGuest Server Action.
 *
 * Verifies:
 *   - Gate order: burst → Turnstile → guestTemplateLimit
 *   - Turnstile failure stops execution before limit is consumed
 *   - Limit failure throws TEMPLATE_LIMIT_GUEST
 *   - Authenticated users are rejected
 *   - No DB INSERT is called (Supabase insert mock is never invoked)
 *   - docx format returns thumbnailDataUrl: null (no CloudConvert)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---- hoisted mocks (must be declared before vi.mock calls) ----
const {
  getUserMock,
  insertMock,
  uploadMock,
  burstLimitMock,
  guestTemplateLimitMock,
  verifyTurnstileMock,
  convertDocxMock,
} = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  insertMock: vi.fn(),
  uploadMock: vi.fn(),
  burstLimitMock: vi.fn(),
  guestTemplateLimitMock: vi.fn(),
  verifyTurnstileMock: vi.fn(),
  convertDocxMock: vi.fn(),
}))

// ---- next/headers mock ----
vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue({ get: () => '1.2.3.4' }),
}))

// ---- Supabase mock ----
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn().mockResolvedValue({
    auth: {
      getUser: getUserMock,
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
    },
    from: vi.fn().mockReturnValue({
      insert: insertMock,
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
    }),
    storage: {
      from: vi.fn().mockReturnValue({
        upload: (...args: unknown[]) => uploadMock(...args),
        remove: vi.fn().mockResolvedValue({ error: null }),
      }),
    },
  }),
}))

// ---- ratelimit mocks ----
vi.mock('@/lib/ratelimit', () => ({
  ipBurstLimit: { limit: (...args: unknown[]) => burstLimitMock(...args) },
  guestTemplateLimit: { limit: (...args: unknown[]) => guestTemplateLimitMock(...args) },
  guestAiDailyLimit: { limit: vi.fn().mockResolvedValue({ success: true, remaining: 2, reset: 0 }) },
}))

// ---- Turnstile mock ----
vi.mock('@/lib/turnstile', () => ({
  verifyTurnstile: (...args: unknown[]) => verifyTurnstileMock(...args),
}))

// ---- client-ip mock ----
vi.mock('@/lib/client-ip', () => ({
  getClientIpFromHeaders: vi.fn().mockReturnValue('1.2.3.4'),
  parseXffFirst: vi.fn(),
  getClientIp: vi.fn(),
}))

// ---- parser / AI mocks ----
vi.mock('@/lib/parsers', () => ({
  getParser: vi.fn().mockReturnValue({
    parse: vi.fn().mockResolvedValue({ text: 'mock text', pages: 1 }),
  }),
}))
vi.mock('@/lib/ai/structure-extractor', () => ({
  extractTemplateStructure: vi.fn().mockResolvedValue({
    fields: [{ name: 'agenda', label: '議題' }],
  }),
}))
vi.mock('@/lib/ai/template-processor', () => ({
  generatePlaceholderDocx: vi.fn().mockResolvedValue(new Uint8Array()),
}))
vi.mock('@/lib/parsers/pdf/analyze-pipeline', () => ({
  analyzePdfFull: vi.fn().mockResolvedValue({
    fields: [{ name: 'agenda', label: '議題' }],
  }),
}))
vi.mock('@/lib/parsers/image/image-to-pdf', () => ({
  imageToA4Pdf: vi.fn().mockResolvedValue(new Uint8Array(4)),
}))
vi.mock('@/lib/pdf-output/image-render-worker', () => ({
  getPdfNumPages: vi.fn().mockResolvedValue(1),
  renderPdfToImages: vi.fn().mockResolvedValue({
    bytes: new Uint8Array([0, 1, 2]),
    ext: 'png',
    contentType: 'image/png',
  }),
}))

// ---- CloudConvert: must NOT be called ----
vi.mock('@/lib/cloudconvert', () => ({
  convertDocxToBlankPdf: (...args: unknown[]) => convertDocxMock(...args),
}))

// ---- Other deps ----
vi.mock('@/lib/pdf-output/template-thumbnail', () => ({
  generateTemplateThumbnail: vi.fn(),
}))
vi.mock('@/lib/db-error-mapper', () => ({
  mapDbErrorToResourceLimit: vi.fn().mockReturnValue(null),
  ResourceLimitError: class extends Error { resource = 'templates' },
}))
vi.mock('@/lib/jwt-claims', () => ({
  decodeAccessTokenClaims: vi.fn().mockReturnValue(null),
}))

// server-only stub
vi.mock('server-only', () => ({}))

// ---- helper: minimal valid base64 ----
const DUMMY_BASE64 = Buffer.from('%PDF-1.4 fake').toString('base64')

import { previewTemplateAsGuest } from '@/server/templates'

beforeEach(() => {
  // Default: guest (no user)
  getUserMock.mockResolvedValue({ data: { user: null }, error: null })
  burstLimitMock.mockResolvedValue({ success: true, remaining: 10, reset: 0 })
  guestTemplateLimitMock.mockResolvedValue({ success: true, remaining: 2, reset: 0 })
  verifyTurnstileMock.mockResolvedValue({ ok: true })
  insertMock.mockReset()
  uploadMock.mockReset()
  convertDocxMock.mockReset()
})

describe('previewTemplateAsGuest — gate order', () => {
  it('throws TOO_MANY_REQUESTS when burst fails (before Turnstile)', async () => {
    burstLimitMock.mockResolvedValue({ success: false, remaining: 0, reset: Date.now() + 1000 })

    await expect(
      previewTemplateAsGuest({ format: 'pdf', fileBase64: DUMMY_BASE64 }),
    ).rejects.toThrow('TOO_MANY_REQUESTS')

    // Turnstile must not be called when burst fails.
    expect(verifyTurnstileMock).not.toHaveBeenCalled()
    expect(guestTemplateLimitMock).not.toHaveBeenCalled()
  })

  it('throws TURNSTILE_FAILED and does NOT consume template limit slot', async () => {
    verifyTurnstileMock.mockResolvedValue({ ok: false, reason: 'invalid-input-response' })

    await expect(
      previewTemplateAsGuest({ format: 'pdf', fileBase64: DUMMY_BASE64, turnstileToken: 'bad' }),
    ).rejects.toThrow('TURNSTILE_FAILED')

    expect(guestTemplateLimitMock).not.toHaveBeenCalled()
  })

  it('throws TEMPLATE_LIMIT_GUEST when limit is exhausted', async () => {
    guestTemplateLimitMock.mockResolvedValue({ success: false, remaining: 0, reset: Date.now() + 1000 })

    await expect(
      previewTemplateAsGuest({ format: 'pdf', fileBase64: DUMMY_BASE64, turnstileToken: 'ok' }),
    ).rejects.toThrow('TEMPLATE_LIMIT_GUEST')
  })
})

describe('previewTemplateAsGuest — auth guard', () => {
  it('throws USE_UPLOAD_TEMPLATE when a logged-in user calls it', async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: 'user-123' } },
      error: null,
    })

    await expect(
      previewTemplateAsGuest({ format: 'pdf', fileBase64: DUMMY_BASE64 }),
    ).rejects.toThrow('USE_UPLOAD_TEMPLATE')
  })
})

describe('previewTemplateAsGuest — no DB write', () => {
  it('does not call Supabase insert', async () => {
    await previewTemplateAsGuest({ format: 'pdf', fileBase64: DUMMY_BASE64, turnstileToken: 'ok' })

    expect(insertMock).not.toHaveBeenCalled()
  })

  it('does not call Supabase storage upload', async () => {
    await previewTemplateAsGuest({ format: 'pdf', fileBase64: DUMMY_BASE64, turnstileToken: 'ok' })

    expect(uploadMock).not.toHaveBeenCalled()
  })

  it('returns fields array', async () => {
    const result = await previewTemplateAsGuest({
      format: 'pdf',
      fileBase64: DUMMY_BASE64,
      turnstileToken: 'ok',
    })

    expect(Array.isArray(result.fields)).toBe(true)
    expect(result.fields.length).toBeGreaterThan(0)
  })
})

describe('previewTemplateAsGuest — docx returns null thumbnail', () => {
  it('does not call CloudConvert and returns thumbnailDataUrl: null for docx', async () => {
    const result = await previewTemplateAsGuest({
      format: 'docx',
      fileBase64: DUMMY_BASE64,
      turnstileToken: 'ok',
    })

    expect(result.thumbnailDataUrl).toBeNull()
    expect(convertDocxMock).not.toHaveBeenCalled()
  })
})

describe('previewTemplateAsGuest — pdf returns thumbnail data URL', () => {
  it('returns a data URL string for pdf format', async () => {
    const result = await previewTemplateAsGuest({
      format: 'pdf',
      fileBase64: DUMMY_BASE64,
      turnstileToken: 'ok',
    })

    expect(result.thumbnailDataUrl).not.toBeNull()
    expect(result.thumbnailDataUrl).toMatch(/^data:image\/png;base64,/)
  })
})
