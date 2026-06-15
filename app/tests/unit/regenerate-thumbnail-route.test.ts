import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * regenerate-thumbnail route の経路分岐テスト（段階1 C-2 / A500 潜在漏れ修正）。
 *
 * 検証主眼:
 *   - whiteout_boxes が 1 件以上 → templates_raw / source_path を download し、
 *     generateTemplateThumbnail に whiteoutBoxes を渡す（A500 を踏む _blank.pdf を使わない）。
 *   - whiteout_boxes 無し（旧データ）→ templates_processed / background_pdf_path 経路（後方互換）。
 *
 * generateTemplateThumbnail と supabase client はモックし、route の分岐ロジックのみを検証する。
 */

const genThumbMock = vi.fn()
vi.mock('@/lib/pdf-output/template-thumbnail', () => ({
  generateTemplateThumbnail: (...args: unknown[]) => genThumbMock(...args),
}))

const createClientMock = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => createClientMock(),
}))

import { POST } from '@/app/api/templates/[id]/regenerate-thumbnail/route'

interface TemplateRow {
  id: string
  family_id: string | null
  source_format: string
  background_pdf_path: string | null
  thumbnail_status: string
  source_path: string | null
  whiteout_boxes: unknown
}

function makeSupabaseStub(template: TemplateRow) {
  const downloadCalls: Array<{ bucket: string; path: string }> = []
  const supabase = {
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: 'user1' } } }),
    },
    storage: {
      from: (bucket: string) => ({
        download: (path: string) => {
          downloadCalls.push({ bucket, path })
          return Promise.resolve({
            data: { arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer) },
            error: null,
          })
        },
      }),
    },
    from: (table: string) => {
      if (table === 'templates') {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve({ data: template, error: null }) }),
          }),
          update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        }
      }
      // family_members: 所属あり
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: { user_id: 'user1' }, error: null }),
            }),
          }),
        }),
      }
    },
  }
  return { supabase, downloadCalls }
}

function makeRequest() {
  return {} as never
}
const params = Promise.resolve({ id: 'tpl1' })

const BASE: TemplateRow = {
  id: 'tpl1',
  family_id: 'fam1',
  source_format: 'pdf',
  background_pdf_path: 'fam1/tpl1_blank.pdf',
  thumbnail_status: 'failed',
  source_path: 'fam1/tpl1.pdf',
  whiteout_boxes: null,
}

describe('regenerate-thumbnail route 経路分岐', () => {
  beforeEach(() => {
    genThumbMock.mockReset()
    createClientMock.mockReset()
    genThumbMock.mockResolvedValue({ ok: true, thumbnailPath: 'fam1/templates/tpl1_72_png.png' })
  })

  it('whiteout_boxes あり: templates_raw を download し whiteoutBoxes を渡す', async () => {
    const boxes = [{ page: 1, bbox: { x: 1, y: 2, width: 3, height: 4 }, source: 'manual' }]
    const { supabase, downloadCalls } = makeSupabaseStub({ ...BASE, whiteout_boxes: boxes })
    createClientMock.mockResolvedValue(supabase)

    const res = await POST(makeRequest(), { params })
    expect(res.status).toBe(200)
    expect(downloadCalls).toEqual([{ bucket: 'templates_raw', path: 'fam1/tpl1.pdf' }])
    expect(genThumbMock).toHaveBeenCalledTimes(1)
    expect(genThumbMock.mock.calls[0][1]).toMatchObject({
      familyId: 'fam1',
      templateId: 'tpl1',
      whiteoutBoxes: boxes,
    })
  })

  it('whiteout_boxes 無し（旧データ）: templates_processed を download し whiteoutBoxes を渡さない', async () => {
    const { supabase, downloadCalls } = makeSupabaseStub({ ...BASE, whiteout_boxes: null })
    createClientMock.mockResolvedValue(supabase)

    const res = await POST(makeRequest(), { params })
    expect(res.status).toBe(200)
    expect(downloadCalls).toEqual([
      { bucket: 'templates_processed', path: 'fam1/tpl1_blank.pdf' },
    ])
    expect(genThumbMock.mock.calls[0][1].whiteoutBoxes).toBeUndefined()
  })

  it('whiteout_boxes 空配列: 従来経路（templates_processed）', async () => {
    const { supabase, downloadCalls } = makeSupabaseStub({ ...BASE, whiteout_boxes: [] })
    createClientMock.mockResolvedValue(supabase)

    await POST(makeRequest(), { params })
    expect(downloadCalls[0].bucket).toBe('templates_processed')
    expect(genThumbMock.mock.calls[0][1].whiteoutBoxes).toBeUndefined()
  })

  it('whiteout_boxes あり & source_path 無し: フォールバックで templates_processed 経路', async () => {
    // raw 再合成不可（source_path 欠落の旧データ）。漏洩防止と整合: 焼き込み済 _blank.pdf を素直に使う。
    const boxes = [{ page: 1, bbox: { x: 1, y: 2, width: 3, height: 4 }, source: 'manual' }]
    const { supabase, downloadCalls } = makeSupabaseStub({
      ...BASE,
      whiteout_boxes: boxes,
      source_path: null,
    })
    createClientMock.mockResolvedValue(supabase)

    const res = await POST(makeRequest(), { params })
    expect(res.status).toBe(200)
    expect(downloadCalls[0].bucket).toBe('templates_processed')
    expect(genThumbMock.mock.calls[0][1].whiteoutBoxes).toBeUndefined()
  })
})
