import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * POST /api/guest/render-image — builtin-only, DB-free background image endpoint
 * used by the (future) guest AdjustView preview.
 *
 * This route must never touch Supabase: there is no createSupabaseServerClient
 * mock anywhere in this file, which is itself part of the regression guard —
 * if the route started importing a DB client, these tests would need a mock to
 * avoid throwing on missing env vars, surfacing the regression immediately.
 */

const loadBuiltinBackgroundPngMock = vi.fn()
vi.mock('@/lib/builtin-bbox-loader', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/builtin-bbox-loader')
  >('@/lib/builtin-bbox-loader')
  return {
    ...actual,
    loadBuiltinBackgroundPng: (...args: unknown[]) =>
      loadBuiltinBackgroundPngMock(...args),
  }
})

const generateBlankA4PngMock = vi.fn()
vi.mock('@/lib/pdf-output/blank-a4-png', () => ({
  generateBlankA4Png: (...args: unknown[]) => generateBlankA4PngMock(...args),
}))

import { POST } from '@/app/api/guest/render-image/route'

const FAMILY_MEETING_ID = '00000000-0000-0000-0000-000000000001'
const NON_BUILTIN_ID = '11111111-1111-1111-1111-111111111111'

function makeRequest(body: unknown) {
  return { json: () => Promise.resolve(body) } as unknown as Parameters<typeof POST>[0]
}

describe('POST /api/guest/render-image', () => {
  beforeEach(() => {
    loadBuiltinBackgroundPngMock.mockReset()
    generateBlankA4PngMock.mockReset()
    generateBlankA4PngMock.mockResolvedValue({ bytes: new Uint8Array([0x42]) })
  })

  it('builtin templateId + raw:true → 200 / image/png / bg.png bytes をそのまま返す', async () => {
    const bgBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    loadBuiltinBackgroundPngMock.mockResolvedValueOnce(bgBytes)

    const res = await POST(
      makeRequest({ templateId: FAMILY_MEETING_ID, content: {}, overrides: {}, raw: true }),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(loadBuiltinBackgroundPngMock).toHaveBeenCalledWith('family-meeting')
    const buf = Buffer.from(await res.arrayBuffer())
    expect(Array.from(buf)).toEqual(Array.from(bgBytes))
    expect(generateBlankA4PngMock).not.toHaveBeenCalled()
  })

  it('非 builtin templateId は 403 TEMPLATE_NOT_ALLOWED（背景ローダを一切呼ばない）', async () => {
    const res = await POST(
      makeRequest({ templateId: NON_BUILTIN_ID, content: {}, overrides: {}, raw: true }),
    )
    expect(res.status).toBe(403)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('TEMPLATE_NOT_ALLOWED')
    expect(loadBuiltinBackgroundPngMock).not.toHaveBeenCalled()
  })

  it('templateId が UUID 形式でない場合は 400 INVALID_REQUEST', async () => {
    const res = await POST(
      makeRequest({ templateId: 'not-a-uuid', content: {}, overrides: {} }),
    )
    expect(res.status).toBe(400)
  })

  it('templateId 欠落は 400 INVALID_REQUEST', async () => {
    const res = await POST(makeRequest({ content: {}, overrides: {} }))
    expect(res.status).toBe(400)
  })

  it('bg.png 読込失敗（null）→ 白紙 A4 PNG にフォールバックする', async () => {
    loadBuiltinBackgroundPngMock.mockResolvedValueOnce(null)
    const res = await POST(
      makeRequest({ templateId: FAMILY_MEETING_ID, content: {}, overrides: {}, raw: true }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(generateBlankA4PngMock).toHaveBeenCalledTimes(1)
  })

  it('content の key 数が上限を超えると 400 INVALID_REQUEST', async () => {
    const tooMany: Record<string, string> = {}
    for (let i = 0; i < 31; i++) tooMany[`k${i}`] = 'v'
    const res = await POST(
      makeRequest({ templateId: FAMILY_MEETING_ID, content: tooMany, overrides: {}, raw: true }),
    )
    expect(res.status).toBe(400)
  })

  it('overrides に未知キーが混入すると strict スキーマで 400 INVALID_REQUEST', async () => {
    const res = await POST(
      makeRequest({
        templateId: FAMILY_MEETING_ID,
        content: {},
        overrides: { attendees: { x: 1, evil: 'payload' } },
        raw: true,
      }),
    )
    expect(res.status).toBe(400)
  })

  it('壊れた JSON body は 400 INVALID_JSON', async () => {
    const req = {
      json: () => Promise.reject(new Error('bad json')),
    } as unknown as Parameters<typeof POST>[0]
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('content value がちょうど 8000 文字なら 200 OK（境界値・上限ぎりぎりは許容）', async () => {
    const bgBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    loadBuiltinBackgroundPngMock.mockResolvedValueOnce(bgBytes)
    const res = await POST(
      makeRequest({
        templateId: FAMILY_MEETING_ID,
        content: { attendees: 'a'.repeat(8000) },
        overrides: {},
        raw: true,
      }),
    )
    expect(res.status).toBe(200)
  })

  it('content value が 8001 文字（8000 超過）だと 400 INVALID_REQUEST', async () => {
    const res = await POST(
      makeRequest({
        templateId: FAMILY_MEETING_ID,
        content: { attendees: 'a'.repeat(8001) },
        overrides: {},
        raw: true,
      }),
    )
    expect(res.status).toBe(400)
    expect(loadBuiltinBackgroundPngMock).not.toHaveBeenCalled()
  })
})
