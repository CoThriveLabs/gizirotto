import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * /api/minutes/[id]/render-image — builtin AdjustView 背景の
 * サムネ PNG 配信経路テスト。
 *
 * 検証主眼:
 *   - builtin (family_id=null) かつ processed_path が seed.sql 既知 slug
 *     → public/builtin-templates/{slug}.png を返す（白紙 A4 ではなく実サムネ）
 *   - builtin だが processed_path が未知 slug → 白紙 A4 fallback
 *
 * user テンプレ render-image 経路（canUseRawOverlay=true 枝・raw 起点）への
 * 副作用ゼロを担保するため、本テストは `source_format !== 'pdf'` 枝のみを対象とする。
 */

const loadBuiltinThumbnailPngMock = vi.fn()
const loadBuiltinBackgroundPngMock = vi.fn()
vi.mock('@/lib/builtin-bbox-loader', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/builtin-bbox-loader')
  >('@/lib/builtin-bbox-loader')
  return {
    ...actual,
    loadBuiltinThumbnailPng: (...args: unknown[]) =>
      loadBuiltinThumbnailPngMock(...args),
    loadBuiltinBackgroundPng: (...args: unknown[]) =>
      loadBuiltinBackgroundPngMock(...args),
  }
})

const generateBlankA4PngMock = vi.fn()
vi.mock('@/lib/pdf-output/blank-a4-png', () => ({
  generateBlankA4Png: (...args: unknown[]) => generateBlankA4PngMock(...args),
}))

const createClientMock = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => createClientMock(),
}))

import { POST } from '@/app/api/minutes/[id]/render-image/route'

const BUILTIN_FAMILY_ID = 'fam-001'

interface StubOpts {
  user?: { id: string } | null
  minute?: Record<string, unknown> | null
  template?: Record<string, unknown> | null
  cacheHit?: boolean
}

function makeSupabaseStub(opts: StubOpts) {
  return {
    auth: {
      getUser: () =>
        Promise.resolve({
          data: { user: 'user' in opts ? opts.user : { id: 'u1' } },
        }),
    },
    from: (table: string) => {
      if (table === 'minutes') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: opts.minute ?? null, error: null }),
            }),
          }),
        }
      }
      if (table === 'templates') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: opts.template ?? null, error: null }),
            }),
          }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
    storage: {
      from: (_bucket: string) => ({
        createSignedUrl: () =>
          Promise.resolve({
            data: opts.cacheHit ? { signedUrl: 'https://cache/hit' } : null,
          }),
        upload: () => Promise.resolve({ data: null, error: null }),
      }),
    },
  }
}

function makeRequest(body: Record<string, unknown> = {}) {
  return {
    json: () => Promise.resolve(body),
  } as unknown as Parameters<typeof POST>[0]
}

const params = Promise.resolve({ id: 'min1' })

const baseMinute = {
  id: 'min1',
  title: 't',
  meeting_date: '2026-06-10',
  family_id: BUILTIN_FAMILY_ID,
  output_pdf_path: null,
  template_id: 'tpl-builtin-fm',
  content_json: {},
  bbox_overrides: {},
  new_fields: null,
}

describe('render-image builtin thumbnail PNG 配信', () => {
  beforeEach(() => {
    loadBuiltinThumbnailPngMock.mockReset()
    loadBuiltinBackgroundPngMock.mockReset()
    generateBlankA4PngMock.mockReset()
    createClientMock.mockReset()
    generateBlankA4PngMock.mockResolvedValue({
      bytes: new Uint8Array([0x42]),
    })
  })

  it('builtin かつ既知 slug → 背景 PNG（{slug}.bg.png）を返す（白紙 fallback を呼ばない）', async () => {
    const builtinBgPngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    loadBuiltinBackgroundPngMock.mockResolvedValueOnce(builtinBgPngBytes)
    createClientMock.mockResolvedValue(
      makeSupabaseStub({
        minute: baseMinute,
        template: {
          id: 'tpl-builtin-fm',
          family_id: null,
          background_pdf_path: null,
          source_path: null,
          source_format: 'docx',
          processed_path: 'builtin/family_meeting_processed.docx',
          whiteout_boxes: [],
          fields: [],
          fixed_texts: [],
        },
      }),
    )

    const res = await POST(makeRequest(), { params })
    expect(res.status).toBe(200)
    // 背景 PNG ローダ（{slug}.bg.png）が呼ばれた
    expect(loadBuiltinBackgroundPngMock).toHaveBeenCalledTimes(1)
    expect(loadBuiltinBackgroundPngMock.mock.calls[0][0]).toBe('family-meeting')
    // 背景 PNG が成功したらサムネ用 PNG ローダは呼ばれない（無駄 IO 回避）
    expect(loadBuiltinThumbnailPngMock).not.toHaveBeenCalled()
    // 白紙 A4 は呼ばれない
    expect(generateBlankA4PngMock).not.toHaveBeenCalled()
  })

  it('builtin だが未知 processed_path → 白紙 A4 fallback が動く', async () => {
    createClientMock.mockResolvedValue(
      makeSupabaseStub({
        minute: baseMinute,
        template: {
          id: 'tpl-unknown',
          family_id: null,
          background_pdf_path: null,
          source_path: null,
          source_format: 'docx',
          processed_path: 'builtin/unknown_processed.docx',
          whiteout_boxes: [],
          fields: [],
          fixed_texts: [],
        },
      }),
    )

    const res = await POST(makeRequest(), { params })
    expect(res.status).toBe(200)
    // slug 不一致 → PNG ローダ自体スキップ（背景もサムネも）
    expect(loadBuiltinBackgroundPngMock).not.toHaveBeenCalled()
    expect(loadBuiltinThumbnailPngMock).not.toHaveBeenCalled()
    // 白紙 A4 fallback が起動
    expect(generateBlankA4PngMock).toHaveBeenCalledTimes(1)
  })

  it('builtin かつ既知 slug で背景 PNG が null → サムネ PNG → 白紙 A4 の順に fallback する（保険温存）', async () => {
    loadBuiltinBackgroundPngMock.mockResolvedValueOnce(null)
    loadBuiltinThumbnailPngMock.mockResolvedValueOnce(null)
    createClientMock.mockResolvedValue(
      makeSupabaseStub({
        minute: baseMinute,
        template: {
          id: 'tpl-builtin-fm',
          family_id: null,
          background_pdf_path: null,
          source_path: null,
          source_format: 'docx',
          processed_path: 'builtin/family_meeting_processed.docx',
          whiteout_boxes: [],
          fields: [],
          fixed_texts: [],
        },
      }),
    )

    const res = await POST(makeRequest(), { params })
    expect(res.status).toBe(200)
    expect(loadBuiltinBackgroundPngMock).toHaveBeenCalledTimes(1)
    expect(loadBuiltinThumbnailPngMock).toHaveBeenCalledTimes(1)
    expect(generateBlankA4PngMock).toHaveBeenCalledTimes(1)
  })

  it('背景 PNG が null でもサムネ PNG があれば白紙 A4 を呼ばずサムネで fallback する', async () => {
    loadBuiltinBackgroundPngMock.mockResolvedValueOnce(null)
    const thumbBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    loadBuiltinThumbnailPngMock.mockResolvedValueOnce(thumbBytes)
    createClientMock.mockResolvedValue(
      makeSupabaseStub({
        minute: baseMinute,
        template: {
          id: 'tpl-builtin-fm',
          family_id: null,
          background_pdf_path: null,
          source_path: null,
          source_format: 'docx',
          processed_path: 'builtin/family_meeting_processed.docx',
          whiteout_boxes: [],
          fields: [],
          fixed_texts: [],
        },
      }),
    )

    const res = await POST(makeRequest(), { params })
    expect(res.status).toBe(200)
    expect(loadBuiltinBackgroundPngMock).toHaveBeenCalledTimes(1)
    expect(loadBuiltinThumbnailPngMock).toHaveBeenCalledTimes(1)
    expect(generateBlankA4PngMock).not.toHaveBeenCalled()
  })
})
