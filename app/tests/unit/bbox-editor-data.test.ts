import { beforeEach, describe, expect, it, vi } from 'vitest'

const rasterMock = vi.fn()

vi.mock('@/lib/parsers/pdf/pdf-page-rasterizer', () => ({
  renderPdfPagesToPng: (...args: unknown[]) => rasterMock(...args),
}))

// loadBboxEditorPages は罫線検出を呼ぶ。背景経路（bucket 振り分け）の検証には無関係なので
// 空配列を返すスタブにし、追加レンダ/デコードを発生させない（テストを軽量・決定的に保つ）。
vi.mock('@/lib/parsers/pdf/field-bbox-detector', () => ({
  detectFieldBboxes: () => Promise.resolve({ boxes: [], pixels: undefined }),
}))

import {
  loadPageSizesOnly,
  loadBboxEditorPages,
} from '@/lib/pdf-output/bbox-editor-data'

function makeSupabaseStub() {
  const downloads: Array<{ bucket: string; path: string }> = []
  const supabase = {
    storage: {
      from: (bucket: string) => ({
        download: (path: string) => {
          downloads.push({ bucket, path })
          return Promise.resolve({
            data: {
              arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
            },
            error: null,
          })
        },
      }),
    },
  }
  return { supabase, downloads }
}

/** loadBboxEditorPages 用のリッチ stub（download/remove/upload/createSignedUrl を記録）。 */
function makeFullSupabaseStub() {
  const downloads: Array<{ bucket: string; path: string }> = []
  const uploads: Array<{ bucket: string; key: string }> = []
  // #18: remove→upload の順序検証用に「操作の発生順」も記録する。
  const ops: string[] = []
  const supabase = {
    storage: {
      from: (bucket: string) => ({
        download: (path: string) => {
          downloads.push({ bucket, path })
          return Promise.resolve({
            data: {
              arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
            },
            error: null,
          })
        },
        // #18: uploadAndSign は upsert:true をやめ remove()→upload(upsert:false) に変更したので
        // stub にも remove を生やす（image_cache の UPDATE policy 無し対策・対象不在でも no-op）。
        remove: (keys: string[]) => {
          for (const k of keys) ops.push(`remove:${k}`)
          return Promise.resolve({ data: [], error: null })
        },
        upload: (key: string) => {
          uploads.push({ bucket, key })
          ops.push(`upload:${key}`)
          return Promise.resolve({ data: { path: key }, error: null })
        },
        createSignedUrl: (key: string) =>
          Promise.resolve({
            data: { signedUrl: `https://signed.example/${key}` },
            error: null,
          }),
      }),
    },
  }
  return { supabase, downloads, uploads, ops }
}

describe('loadBboxEditorPages compositePolicy', () => {
  beforeEach(() => {
    rasterMock.mockReset()
    rasterMock.mockResolvedValue([
      {
        page: 1,
        pngBuffer: new Uint8Array([9, 9, 9]),
        pagePtSize: { width: 595, height: 842 },
        pixelWidth: 1190,
        pixelHeight: 1684,
      },
    ])
  })

  it("compositePolicy='both' で source_path があれば raw 背景も返す（rawPreviewImageUrls 非 null）", async () => {
    const { supabase, uploads } = makeFullSupabaseStub()
    const pages = await loadBboxEditorPages(
      supabase as never,
      'fam',
      'tpl',
      'fam/tpl_blank.pdf',
      { compositePolicy: 'both', sourcePath: 'fam/tpl.pdf', cacheVersion: 'v1' },
    )
    expect(pages.rawPreviewImageUrls).not.toBeUndefined()
    expect(pages.rawPreviewImageUrls?.[0]).toContain('_bbox_editor_raw_p1.png')
    // cacheVersion が signedUrl に版数として付与される。
    expect(pages.rawPreviewImageUrls?.[0]).toContain('v=v1')
    // raw 背景用 upload が _raw_ キーで行われる。
    expect(uploads.some((u) => u.key.includes('_bbox_editor_raw_p1.png'))).toBe(true)
  })

  it('#18: 各 cacheKey で upsert:true ではなく remove()→upload() の順で置換する（焼込PNG固着の根治）', async () => {
    // 記入欄背景（焼込済 _bbox_editor_pN.png）の image_cache を毎回 remove→upload で確実に置換することを検証。
    // upsert:true は image_cache の UPDATE policy 無しで弾かれ古い背景が固着する真因だったため、
    // remove が同一キーの upload より必ず先に来ることを ops 列で固定する。
    const { supabase, ops } = makeFullSupabaseStub()
    await loadBboxEditorPages(supabase as never, 'fam', 'tpl', 'fam/tpl_blank.pdf', {})
    const key = 'fam/templates/tpl_bbox_editor_p1.png'
    const removeIdx = ops.indexOf(`remove:${key}`)
    const uploadIdx = ops.indexOf(`upload:${key}`)
    expect(removeIdx).toBeGreaterThanOrEqual(0)
    expect(uploadIdx).toBeGreaterThanOrEqual(0)
    expect(removeIdx).toBeLessThan(uploadIdx)
  })

  it("compositePolicy='both' でも source_path が null なら raw を出さず従来経路にフォールバック", async () => {
    const { supabase, downloads, uploads } = makeFullSupabaseStub()
    const pages = await loadBboxEditorPages(
      supabase as never,
      'fam',
      'tpl',
      'fam/tpl_blank.pdf',
      { compositePolicy: 'both', sourcePath: null },
    )
    // raw 経路は発動しない: rawPreviewImageUrls は undefined。
    expect(pages.rawPreviewImageUrls).toBeUndefined()
    // 背景 PDF は従来の _blank.pdf（templates_processed）から取る。
    expect(downloads).toEqual([
      { bucket: 'templates_processed', path: 'fam/tpl_blank.pdf' },
    ])
    // _raw_ キーの upload は行われない。
    expect(uploads.some((u) => u.key.includes('_raw_'))).toBe(false)
  })
})

describe('loadPageSizesOnly', () => {
  beforeEach(() => {
    rasterMock.mockReset()
    rasterMock.mockResolvedValue([
      {
        page: 1,
        pagePtSize: { width: 595, height: 842 },
        pixelWidth: 1190,
        pixelHeight: 1684,
      },
    ])
  })

  it('uses raw PDF when whiteout boxes exist to avoid rasterizing the blank PDF', async () => {
    const { supabase, downloads } = makeSupabaseStub()

    const pages = await loadPageSizesOnly(
      supabase as never,
      'fam/tpl_blank.pdf',
      {
        sourcePath: 'fam/tpl.pdf',
        whiteoutBoxes: [
          {
            page: 1,
            bbox: { x: 10, y: 20, w: 30, h: 40 },
            estimatedBgColor: { r: 255, g: 255, b: 255 },
            source: 'manual',
          },
        ],
      },
    )

    expect(downloads).toEqual([
      { bucket: 'templates_raw', path: 'fam/tpl.pdf' },
    ])
    expect(pages).toEqual([
      {
        page: 1,
        widthPt: 595,
        heightPt: 842,
        pixelWidth: 1190,
        pixelHeight: 1684,
      },
    ])
  })

  it('keeps the legacy blank PDF path when there are no whiteout boxes', async () => {
    const { supabase, downloads } = makeSupabaseStub()

    await loadPageSizesOnly(supabase as never, 'fam/tpl_blank.pdf', {
      sourcePath: 'fam/tpl.pdf',
      whiteoutBoxes: [],
    })

    expect(downloads).toEqual([
      { bucket: 'templates_processed', path: 'fam/tpl_blank.pdf' },
    ])
  })
})
