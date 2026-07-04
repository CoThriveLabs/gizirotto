// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

// server-only は vitest.config.ts で stub されている。
// uploadTemplate は 'use server' かつ server-only 依存があるため、
// 主要な依存をすべてモックしてから import する。

const mockSupabaseFrom = vi.fn()
const mockSupabaseStorage = vi.fn()
const mockGetUser = vi.fn()
const mockGetSession = vi.fn()
const mockAnalyzePdfFull = vi.fn()
const mockImageToA4Pdf = vi.fn()
const mockExtractTemplateStructure = vi.fn()
const mockGeneratePlaceholderDocx = vi.fn()
const mockGenerateTemplateThumbnail = vi.fn()
const mockDecodeAccessTokenClaims = vi.fn()
const mockConvertDocxToBlankPdf = vi.fn()
const mockMapDbErrorToResourceLimit = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn().mockResolvedValue({
    auth: {
      getUser: mockGetUser,
      getSession: mockGetSession,
    },
    from: mockSupabaseFrom,
    storage: {
      from: mockSupabaseStorage,
    },
  }),
}))

vi.mock('@/lib/parsers/pdf/analyze-pipeline', () => ({
  analyzePdfFull: mockAnalyzePdfFull,
}))

vi.mock('@/lib/parsers/image/image-to-pdf', () => ({
  imageToA4Pdf: mockImageToA4Pdf,
}))

vi.mock('@/lib/ai/structure-extractor', () => ({
  extractTemplateStructure: mockExtractTemplateStructure,
}))

vi.mock('@/lib/ai/template-processor', () => ({
  generatePlaceholderDocx: mockGeneratePlaceholderDocx,
}))

vi.mock('@/lib/pdf-output/template-thumbnail', () => ({
  generateTemplateThumbnail: mockGenerateTemplateThumbnail,
}))

vi.mock('@/lib/jwt-claims', () => ({
  decodeAccessTokenClaims: mockDecodeAccessTokenClaims,
}))

vi.mock('@/lib/cloudconvert', () => ({
  convertDocxToBlankPdf: mockConvertDocxToBlankPdf,
}))

vi.mock('@/lib/db-error-mapper', () => ({
  mapDbErrorToResourceLimit: mockMapDbErrorToResourceLimit,
  ResourceLimitError: class ResourceLimitError extends Error {
    resource: string
    constructor(resource: string) {
      super('RESOURCE_LIMIT_EXCEEDED')
      this.name = 'ResourceLimitError'
      this.resource = resource
    }
  },
}))

// parsers の mock（image は parsers factory を通らないが、pdf 経路を通るため必要）
vi.mock('@/lib/parsers', () => ({
  getParser: vi.fn().mockReturnValue({
    format: 'pdf',
    parse: vi.fn().mockResolvedValue({ kind: 'text', text: '' }),
  }),
}))

// 小さな PNG バイト列（テスト用）
function makePngBytes(): Uint8Array {
  // 最小 PNG ヘッダ（実際の内容でなくてもモックが通ればよい）
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(100).fill(0)])
}

function makePdfBytes(): Uint8Array {
  return new Uint8Array([0x25, 0x50, 0x44, 0x46, ...new Array(100).fill(0)]) // %PDF
}

function base64Encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

// ──────────────────────────────────────────────────────────
// Supabase mock ヘルパー
// ──────────────────────────────────────────────────────────

function setupSupabaseMocks({
  analyzeResult = { fields: [] },
  insertResult = { data: { id: 'test-template-id' }, error: null },
}: {
  analyzeResult?: { fields: unknown[] }
  insertResult?: { data: unknown; error: unknown }
} = {}) {
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
  mockGetSession.mockResolvedValue({
    data: { session: { access_token: 'test-token' } },
  })
  mockDecodeAccessTokenClaims.mockReturnValue({ family_id: 'family-1' })

  mockExtractTemplateStructure.mockResolvedValue({
    fields: [{ name: 'test_field', type: 'text' }],
  })
  mockGeneratePlaceholderDocx.mockResolvedValue(new Uint8Array(10))
  mockGenerateTemplateThumbnail.mockResolvedValue(undefined)
  mockAnalyzePdfFull.mockResolvedValue(analyzeResult)
  mockMapDbErrorToResourceLimit.mockReturnValue(null)

  // Storage mock: upload, createSignedUrl ともに成功を返す
  const uploadMock = vi.fn().mockResolvedValue({ error: null })
  const storageBucketMock = {
    upload: uploadMock,
    download: vi.fn().mockResolvedValue({ data: null, error: { message: 'not found' } }),
    createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://example.com/signed' } }),
  }
  mockSupabaseStorage.mockReturnValue(storageBucketMock)

  // from('templates') に対する select/insert/update チェーン
  const updateMock = vi.fn().mockReturnValue({
    eq: vi.fn().mockResolvedValue({ error: null }),
  })
  const insertSelectSingleMock = {
    select: vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue(insertResult),
    }),
  }
  const insertMock = vi.fn().mockReturnValue(insertSelectSingleMock)

  mockSupabaseFrom.mockReturnValue({
    insert: insertMock,
    update: updateMock,
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({ data: null, error: null }),
      }),
    }),
  })

  return { uploadMock, insertMock, updateMock }
}

// ──────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────

describe('uploadTemplate — image format', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('image 入力時に imageToA4Pdf が呼ばれ analyzePdfFull が inputPathType B で呼ばれる', async () => {
    const pdfBytes = makePdfBytes()
    mockImageToA4Pdf.mockResolvedValue(pdfBytes)

    const { insertMock } = setupSupabaseMocks({
      analyzeResult: { fields: [{ name: 'field1', bbox: { x: 0, y: 0, width: 100, height: 20, page: 0 } }] },
    })

    const { uploadTemplate } = await import('@/server/templates')

    const imageBytes = makePngBytes()
    const fileBase64 = base64Encode(imageBytes)

    await uploadTemplate({
      name: 'テスト画像テンプレ',
      format: 'image',
      fileBase64,
      imageMime: 'image/png',
    })

    // imageToA4Pdf が呼ばれること
    expect(mockImageToA4Pdf).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      'image/png',
    )

    // analyzePdfFull が inputPathType B で呼ばれること
    expect(mockAnalyzePdfFull).toHaveBeenCalledWith(
      expect.objectContaining({ inputPathType: 'B' }),
    )

    // insert に origin_format: 'image', source_format: 'pdf' が渡ること
    const insertCall = insertMock.mock.calls[0][0]
    expect(insertCall.source_format).toBe('pdf')
    expect(insertCall.origin_format).toBe('image')
  })

  it('OCR 0 fields の場合は汎用 schema.fields にフォールバック（insert に fields が入る）', async () => {
    const pdfBytes = makePdfBytes()
    mockImageToA4Pdf.mockResolvedValue(pdfBytes)

    // analyzePdfFull が 0 fields を返す（フォールバック条件）
    const { insertMock } = setupSupabaseMocks({
      analyzeResult: { fields: [] },
    })

    const { uploadTemplate } = await import('@/server/templates')

    const imageBytes = makePngBytes()
    const fileBase64 = base64Encode(imageBytes)

    await uploadTemplate({
      name: 'OCR ゼロテスト',
      format: 'image',
      fileBase64,
      imageMime: 'image/jpeg',
    })

    // fields は extractTemplateStructure の結果（フォールバック）
    const insertCall = insertMock.mock.calls[0][0]
    expect(Array.isArray(insertCall.fields)).toBe(true)
    expect(insertCall.fields.length).toBeGreaterThan(0)
    // origin_format は 'image' のまま
    expect(insertCall.origin_format).toBe('image')
  })

  it('DB INSERT に source_format: pdf, origin_format: image が入る', async () => {
    const pdfBytes = makePdfBytes()
    mockImageToA4Pdf.mockResolvedValue(pdfBytes)

    const { insertMock } = setupSupabaseMocks()

    const { uploadTemplate } = await import('@/server/templates')

    const imageBytes = makePngBytes()
    const fileBase64 = base64Encode(imageBytes)

    await uploadTemplate({
      name: 'DB INSERT テスト',
      format: 'image',
      fileBase64,
      imageMime: 'image/webp',
    })

    const insertCall = insertMock.mock.calls[0][0]
    expect(insertCall.source_format).toBe('pdf')
    expect(insertCall.origin_format).toBe('image')
  })

  it('imageMime 未指定かつ format=image は zod エラー', async () => {
    const { uploadTemplate } = await import('@/server/templates')

    const imageBytes = makePngBytes()
    const fileBase64 = base64Encode(imageBytes)

    await expect(
      uploadTemplate({
        name: 'バリデーションテスト',
        format: 'image',
        fileBase64,
        // imageMime: undefined — 省略
      }),
    ).rejects.toThrow()
  })
})
