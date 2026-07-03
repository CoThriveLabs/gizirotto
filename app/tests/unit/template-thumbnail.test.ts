import { describe, it, expect, vi, beforeEach } from 'vitest'

// image-renderer をモック（worker spawn を避ける）
const renderMock = vi.fn()
const numPagesMock = vi.fn()
vi.mock('@/lib/pdf-output/image-render-worker', () => ({
  renderPdfToImages: (...args: unknown[]) => renderMock(...args),
  getPdfNumPages: (...args: unknown[]) => numPagesMock(...args),
}))

// raw ラスタライザ + whiteout/fixedtext 合成もモック（pdfjs worker spawn を避ける）。
const rasterizeMock = vi.fn()
vi.mock('@/lib/parsers/pdf/pdf-page-rasterizer', () => ({
  renderPdfPagesToPng: (...args: unknown[]) => rasterizeMock(...args),
}))
const whiteoutMock = vi.fn()
vi.mock('@/lib/parsers/pdf/whiteout-composite', () => ({
  compositeWhiteoutOnPng: (...args: unknown[]) => whiteoutMock(...args),
}))
const fixedTextMock = vi.fn()
vi.mock('@/lib/pdf-output/fixedtext-composite', () => ({
  compositeFixedTextsOnPng: (...args: unknown[]) => fixedTextMock(...args),
}))

import { generateTemplateThumbnail } from '@/lib/pdf-output/template-thumbnail'

/** templates.update().eq() をチェーンで記録するスタブ。 */
function makeSupabaseStub(opts: {
  uploadError?: unknown
  updateError?: unknown
}) {
  const updates: Array<Record<string, unknown>> = []
  const uploadCalls: Array<{ key: string; upsert?: boolean }> = []
  const removeCalls: Array<{ keys: string[] }> = []
  const supabase = {
    storage: {
      from: () => ({
        upload: (key: string, _blob: unknown, opts2?: { upsert?: boolean }) => {
          uploadCalls.push({ key, upsert: opts2?.upsert })
          return Promise.resolve({ error: opts.uploadError ?? null })
        },
        remove: (keys: string[]) => {
          removeCalls.push({ keys })
          return Promise.resolve({ error: null, data: [] })
        },
      }),
    },
    from: () => ({
      update: (patch: Record<string, unknown>) => {
        updates.push(patch)
        return {
          eq: () => Promise.resolve({ error: opts.updateError ?? null }),
        }
      },
    }),
  }
  return { supabase, updates, uploadCalls, removeCalls }
}

const PDF = new Uint8Array([1, 2, 3])

describe('generateTemplateThumbnail', () => {
  beforeEach(() => {
    renderMock.mockReset()
    numPagesMock.mockReset()
    rasterizeMock.mockReset()
    whiteoutMock.mockReset()
    fixedTextMock.mockReset()
  })

  it('正常: render → image_cache upsert → ready 遷移', async () => {
    numPagesMock.mockResolvedValue(1)
    renderMock.mockResolvedValue({
      bytes: new Uint8Array([9, 9]),
      contentType: 'image/png',
      ext: 'png',
    })
    const { supabase, updates, uploadCalls } = makeSupabaseStub({})

    const res = await generateTemplateThumbnail(supabase as never, {
      familyId: 'fam1',
      templateId: 'tpl1',
      pdfBytes: PDF,
    })

    expect(res).toEqual({
      ok: true,
      thumbnailPath: 'fam1/templates/tpl1_72_png.png',
    })
    expect(uploadCalls[0].key).toBe('fam1/templates/tpl1_72_png.png')
    expect(updates).toContainEqual({
      thumbnail_path: 'fam1/templates/tpl1_72_png.png',
      thumbnail_status: 'ready',
    })
  })

  it('異常: レンダリング例外で failed 遷移し throw しない', async () => {
    numPagesMock.mockResolvedValue(1)
    renderMock.mockRejectedValue(new Error('boom'))
    const { supabase, updates } = makeSupabaseStub({})

    const res = await generateTemplateThumbnail(supabase as never, {
      familyId: 'fam1',
      templateId: 'tpl1',
      pdfBytes: PDF,
    })

    expect(res).toEqual({ ok: false, code: 'RENDER_FAILED' })
    expect(updates).toContainEqual({ thumbnail_status: 'failed' })
  })

  it('upload 失敗で failed 遷移', async () => {
    numPagesMock.mockResolvedValue(1)
    renderMock.mockResolvedValue({
      bytes: new Uint8Array([9]),
      contentType: 'image/png',
      ext: 'png',
    })
    const { supabase, updates } = makeSupabaseStub({
      uploadError: { message: 'nope' },
    })

    const res = await generateTemplateThumbnail(supabase as never, {
      familyId: 'fam1',
      templateId: 'tpl1',
      pdfBytes: PDF,
    })

    expect(res).toEqual({ ok: false, code: 'UPLOAD_FAILED' })
    expect(updates).toContainEqual({ thumbnail_status: 'failed' })
  })

  it('upload は upsert:false で remove(cacheKey) 後に呼ばれる（image_cache UPDATE policy 不在対策）', async () => {
    numPagesMock.mockResolvedValue(1)
    renderMock.mockResolvedValue({
      bytes: new Uint8Array([9, 9]),
      contentType: 'image/png',
      ext: 'png',
    })
    const { supabase, uploadCalls, removeCalls } = makeSupabaseStub({})

    const res = await generateTemplateThumbnail(supabase as never, {
      familyId: 'fam1',
      templateId: 'tpl1',
      pdfBytes: PDF,
    })
    expect(res.ok).toBe(true)
    expect(removeCalls).toEqual([{ keys: ['fam1/templates/tpl1_72_png.png'] }])
    expect(uploadCalls[0]).toMatchObject({
      key: 'fam1/templates/tpl1_72_png.png',
      upsert: false,
    })
  })

  it('whiteoutBoxes が空配列なら従来経路（renderPdfToImages）を通る', async () => {
    numPagesMock.mockResolvedValue(1)
    renderMock.mockResolvedValue({
      bytes: new Uint8Array([1]),
      contentType: 'image/png',
      ext: 'png',
    })
    const { supabase } = makeSupabaseStub({})

    const res = await generateTemplateThumbnail(supabase as never, {
      familyId: 'fam1',
      templateId: 'tpl1',
      pdfBytes: PDF,
      whiteoutBoxes: [],
    })
    expect(res.ok).toBe(true)
    expect(renderMock).toHaveBeenCalledTimes(1)
  })

  it('fixedTexts 指定時は raw ラスタライズ→固定テキスト合成経路を通る（whiteout なし）', async () => {
    rasterizeMock.mockResolvedValue([
      {
        page: 1,
        pngBuffer: new Uint8Array([5, 5]),
        pixelWidth: 595,
        pixelHeight: 842,
        pagePtSize: { width: 595, height: 842, page: 1 },
        scale: 1,
      },
    ])
    fixedTextMock.mockResolvedValue(new Uint8Array([7, 7, 7]))
    const { supabase, uploadCalls } = makeSupabaseStub({})

    const res = await generateTemplateThumbnail(supabase as never, {
      familyId: 'fam1',
      templateId: 'tpl1',
      pdfBytes: PDF,
      fixedTexts: [
        {
          name: 'ft_1',
          value: '会議名サンプル',
          bbox: { page: 1, x: 50, y: 50, w: 200, h: 24 },
          font: { family: 'NotoSansJP', size: 14 },
        },
      ],
    })

    expect(res.ok).toBe(true)
    expect(rasterizeMock).toHaveBeenCalledTimes(1)
    expect(fixedTextMock).toHaveBeenCalledTimes(1)
    expect(whiteoutMock).not.toHaveBeenCalled()
    // 従来 renderPdfToImages 経路は通らない（raw ラスタ経路）。
    expect(renderMock).not.toHaveBeenCalled()
    expect(uploadCalls[0].key).toBe('fam1/templates/tpl1_72_png.png')
  })

  it('whiteoutBoxes + fixedTexts 両方指定で whiteout → fixedText の順に重ねる', async () => {
    rasterizeMock.mockResolvedValue([
      {
        page: 1,
        pngBuffer: new Uint8Array([1]),
        pixelWidth: 595,
        pixelHeight: 842,
        pagePtSize: { width: 595, height: 842, page: 1 },
        scale: 1,
      },
    ])
    whiteoutMock.mockResolvedValue(new Uint8Array([2, 2]))
    fixedTextMock.mockResolvedValue(new Uint8Array([3, 3, 3]))
    const { supabase } = makeSupabaseStub({})

    const res = await generateTemplateThumbnail(supabase as never, {
      familyId: 'fam1',
      templateId: 'tpl1',
      pdfBytes: PDF,
      whiteoutBoxes: [
        {
          page: 1,
          bbox: { x: 0, y: 0, w: 10, h: 10 },
          estimatedBgColor: { r: 255, g: 255, b: 255 },
          source: 'auto',
        } as never,
      ],
      fixedTexts: [
        {
          name: 'ft_1',
          value: 'X',
          bbox: { page: 1, x: 0, y: 0, w: 50, h: 14 },
          font: { family: 'NotoSansJP', size: 10 },
        },
      ],
    })

    expect(res.ok).toBe(true)
    // 順序: whiteout → fixedText（whiteout 出力を fixedText 入力に渡す）。
    expect(whiteoutMock).toHaveBeenCalledTimes(1)
    expect(fixedTextMock).toHaveBeenCalledTimes(1)
    const fixedCallArg = fixedTextMock.mock.calls[0][0] as { pngBuffer: Uint8Array }
    expect(Array.from(fixedCallArg.pngBuffer)).toEqual([2, 2])
  })

  it('fixedTexts が空配列なら従来 renderPdfToImages 経路（非破壊）', async () => {
    numPagesMock.mockResolvedValue(1)
    renderMock.mockResolvedValue({
      bytes: new Uint8Array([0]),
      contentType: 'image/png',
      ext: 'png',
    })
    const { supabase } = makeSupabaseStub({})

    const res = await generateTemplateThumbnail(supabase as never, {
      familyId: 'fam1',
      templateId: 'tpl1',
      pdfBytes: PDF,
      fixedTexts: [],
    })
    expect(res.ok).toBe(true)
    expect(renderMock).toHaveBeenCalledTimes(1)
    expect(rasterizeMock).not.toHaveBeenCalled()
    expect(fixedTextMock).not.toHaveBeenCalled()
  })

  it('builtin (familyId=null) は生成せず BUILTIN_NOT_SUPPORTED', async () => {
    const { supabase } = makeSupabaseStub({})
    const res = await generateTemplateThumbnail(supabase as never, {
      familyId: null,
      templateId: 'tpl1',
      pdfBytes: PDF,
    })
    expect(res).toEqual({ ok: false, code: 'BUILTIN_NOT_SUPPORTED' })
    // render は呼ばれない（docx/builtin が呼出側で弾かれる相当の保険）
    expect(renderMock).not.toHaveBeenCalled()
  })
})
