import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * minute-thumbnail.ts の振る舞い検証。
 *
 * シグネチャが `{ minuteId }` のみで、内部で minutes / templates を
 * 取得して `renderMinuteRawWithOverlayToImages`（raw 起点経路）でサムネ合成する。
 *
 * 検証主眼:
 *   - minute 不在 → markFailed + MINUTE_NOT_FOUND
 *   - builtin (family_id=null) → markFailed + BUILTIN_NOT_SUPPORTED
 *   - template_id 欠落 → markFailed + TEMPLATE_NOT_FOUND
 *   - template 不在 → markFailed + TEMPLATE_NOT_FOUND
 *   - source_path null → markFailed + RAW_PATH_NOT_AVAILABLE
 *   - raw PDF download 失敗 → markFailed + RAW_FETCH_FAILED
 *   - render 例外 → markFailed + RENDER_FAILED（1 回失敗で failed 確定）
 *   - upload エラー → markFailed + UPLOAD_FAILED
 *   - 成功時は ready 遷移
 *   - markMinuteThumbnailFailed が status='failed' を minutes に書く
 */

const renderMock = vi.fn()
vi.mock('@/lib/pdf-output/image-renderer', () => ({
  renderMinuteRawWithOverlayToImages: (...args: unknown[]) => renderMock(...args),
}))

import {
  generateMinuteThumbnail,
  markMinuteThumbnailFailed,
} from '@/lib/pdf-output/minute-thumbnail'

interface SupabaseStubOptions {
  minute?: {
    id: string
    family_id: string | null
    template_id: string | null
    content_json?: unknown
    bbox_overrides?: unknown
    new_fields?: unknown
  } | null
  minuteSelectError?: { message: string } | null
  template?: {
    source_path: string | null
    family_id?: string | null
    processed_path?: string | null
    whiteout_boxes?: unknown
    fields?: unknown
    fixed_texts?: unknown
  } | null
  templateSelectError?: { message: string } | null
  rawDownloadError?: { message: string } | null
  uploadError?: { message: string } | null
  updateError?: { message: string } | null
}

function makeSupabase(opts: SupabaseStubOptions) {
  const updates: Array<{ table: string; patch: unknown; id: string }> = []
  const storageOps: Array<{ op: string; bucket: string; key: string }> = []
  const supabase = {
    storage: {
      from: (bucket: string) => ({
        remove: (keys: string[]) => {
          storageOps.push({ op: 'remove', bucket, key: keys[0] })
          return Promise.resolve({ error: null })
        },
        upload: (key: string) => {
          storageOps.push({ op: 'upload', bucket, key })
          return Promise.resolve({
            data: opts.uploadError ? null : { path: key },
            error: opts.uploadError ?? null,
          })
        },
        download: (path: string) => {
          storageOps.push({ op: 'download', bucket, key: path })
          if (opts.rawDownloadError) {
            return Promise.resolve({ data: null, error: opts.rawDownloadError })
          }
          return Promise.resolve({
            data: {
              arrayBuffer: () => Promise.resolve(new Uint8Array([0x25, 0x50]).buffer),
            },
            error: null,
          })
        },
      }),
    },
    from: (table: string) => {
      if (table === 'minutes') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: 'minute' in opts ? opts.minute : null,
                  error: opts.minuteSelectError ?? null,
                }),
            }),
          }),
          update: (patch: unknown) => ({
            eq: (_col: string, id: string) => {
              updates.push({ table, patch, id })
              return Promise.resolve({ error: opts.updateError ?? null })
            },
          }),
        }
      }
      if (table === 'templates') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: 'template' in opts ? opts.template : null,
                  error: opts.templateSelectError ?? null,
                }),
            }),
          }),
        }
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      }
    },
  }
  return { supabase, updates, storageOps }
}

const minimalMinute = {
  id: 'min1',
  family_id: 'fam1',
  template_id: 'tpl1',
  content_json: null,
  bbox_overrides: null,
  new_fields: null,
}
const minimalTemplate = {
  source_path: 'fam1/tpl1.pdf',
  whiteout_boxes: [],
  fields: [],
  fixed_texts: [],
}

describe('generateMinuteThumbnail (v1.2 raw 起点)', () => {
  beforeEach(() => {
    renderMock.mockReset()
    renderMock.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      ext: 'png',
      contentType: 'image/png',
      dpiDecision: { dpi: 72, downgraded: false, estimatedMs: 0 },
      renderedPages: 1,
      warnings: [],
    })
  })

  it('minute 不在 → markFailed + MINUTE_NOT_FOUND', async () => {
    const { supabase, updates } = makeSupabase({ minute: null })
    const res = await generateMinuteThumbnail(supabase as never, { minuteId: 'min1' })
    expect(res).toEqual({ ok: false, code: 'MINUTE_NOT_FOUND' })
    expect(updates).toContainEqual({
      table: 'minutes',
      patch: { thumbnail_status: 'failed' },
      id: 'min1',
    })
  })

  it('builtin (familyId=null) → markFailed + BUILTIN_NOT_SUPPORTED', async () => {
    const { supabase, updates } = makeSupabase({
      minute: { ...minimalMinute, family_id: null },
    })
    const res = await generateMinuteThumbnail(supabase as never, { minuteId: 'min1' })
    expect(res).toEqual({ ok: false, code: 'BUILTIN_NOT_SUPPORTED' })
    expect(updates).toContainEqual({
      table: 'minutes',
      patch: { thumbnail_status: 'failed' },
      id: 'min1',
    })
  })

  it('template_id 欠落 → markFailed + TEMPLATE_NOT_FOUND', async () => {
    const { supabase, updates } = makeSupabase({
      minute: { ...minimalMinute, template_id: null },
    })
    const res = await generateMinuteThumbnail(supabase as never, { minuteId: 'min1' })
    expect(res).toEqual({ ok: false, code: 'TEMPLATE_NOT_FOUND' })
    expect(updates).toContainEqual({
      table: 'minutes',
      patch: { thumbnail_status: 'failed' },
      id: 'min1',
    })
  })

  it('template 不在 → markFailed + TEMPLATE_NOT_FOUND', async () => {
    const { supabase, updates } = makeSupabase({
      minute: minimalMinute,
      template: null,
    })
    const res = await generateMinuteThumbnail(supabase as never, { minuteId: 'min1' })
    expect(res).toEqual({ ok: false, code: 'TEMPLATE_NOT_FOUND' })
    expect(updates).toContainEqual({
      table: 'minutes',
      patch: { thumbnail_status: 'failed' },
      id: 'min1',
    })
  })

  it('source_path null (user テンプレ・family_id 有り) → markFailed + RAW_PATH_NOT_AVAILABLE', async () => {
    // 既存挙動温存: user テンプレで source_path が落ちている異常系は引き続き失敗扱い。
    const { supabase, updates } = makeSupabase({
      minute: minimalMinute,
      template: {
        ...minimalTemplate,
        source_path: null,
        family_id: 'famX',
        processed_path: 'tpl/some-user.docx',
      },
    })
    const res = await generateMinuteThumbnail(supabase as never, { minuteId: 'min1' })
    expect(res).toEqual({ ok: false, code: 'RAW_PATH_NOT_AVAILABLE' })
    expect(updates).toContainEqual({
      table: 'minutes',
      patch: { thumbnail_status: 'failed' },
      id: 'min1',
    })
  })

  it('source_path null だが builtin (family_id=null + 既知 processed_path) → bg.png を image_cache に upload + ready 遷移', async () => {
    // family_meeting builtin から作成した議事録の再現ケース。
    // raw PDF 経路を経由せず public/builtin-templates/family-meeting.bg.png を
    // 直接 image_cache に保存して再生成成功とする。
    const { supabase, updates, storageOps } = makeSupabase({
      minute: minimalMinute,
      template: {
        ...minimalTemplate,
        source_path: null,
        family_id: null,
        processed_path: 'builtin/family_meeting_processed.docx',
      },
    })
    const res = await generateMinuteThumbnail(supabase as never, { minuteId: 'min1' })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.thumbnailPath).toBe('fam1/minutes/min1_72_png.png')
    }
    // templates_raw からの download は呼ばれず、image_cache の remove → upload のみ。
    expect(storageOps.map((o) => `${o.bucket}:${o.op}`)).toEqual([
      'image_cache:remove',
      'image_cache:upload',
    ])
    // renderMinuteRawWithOverlayToImages は呼ばれない（raw 経路バイパス）。
    expect(renderMock).not.toHaveBeenCalled()
    // ready 遷移
    expect(updates).toContainEqual({
      table: 'minutes',
      patch: {
        thumbnail_path: 'fam1/minutes/min1_72_png.png',
        thumbnail_status: 'ready',
      },
      id: 'min1',
    })
  })

  it('builtin 経路で upload エラー → markFailed + UPLOAD_FAILED', async () => {
    const { supabase, updates } = makeSupabase({
      minute: minimalMinute,
      template: {
        ...minimalTemplate,
        source_path: null,
        family_id: null,
        processed_path: 'builtin/budget_report_processed.docx',
      },
      uploadError: { message: 'rls denied' },
    })
    const res = await generateMinuteThumbnail(supabase as never, { minuteId: 'min1' })
    expect(res).toEqual({ ok: false, code: 'UPLOAD_FAILED' })
    expect(updates).toContainEqual({
      table: 'minutes',
      patch: { thumbnail_status: 'failed' },
      id: 'min1',
    })
  })

  it('raw PDF download 失敗 → markFailed + RAW_FETCH_FAILED', async () => {
    const { supabase, updates } = makeSupabase({
      minute: minimalMinute,
      template: minimalTemplate,
      rawDownloadError: { message: 'NotFound' },
    })
    const res = await generateMinuteThumbnail(supabase as never, { minuteId: 'min1' })
    expect(res).toEqual({ ok: false, code: 'RAW_FETCH_FAILED' })
    expect(updates).toContainEqual({
      table: 'minutes',
      patch: { thumbnail_status: 'failed' },
      id: 'min1',
    })
  })

  it('正常系: templates_raw download → render → image_cache remove→upload + minutes ready 遷移', async () => {
    const { supabase, updates, storageOps } = makeSupabase({
      minute: minimalMinute,
      template: minimalTemplate,
    })
    const res = await generateMinuteThumbnail(supabase as never, { minuteId: 'min1' })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.thumbnailPath).toBe('fam1/minutes/min1_72_png.png')
    }
    // templates_raw download → image_cache remove → image_cache upload の順
    expect(storageOps.map((o) => `${o.bucket}:${o.op}`)).toEqual([
      'templates_raw:download',
      'image_cache:remove',
      'image_cache:upload',
    ])
    // ready 遷移
    expect(updates).toContainEqual({
      table: 'minutes',
      patch: {
        thumbnail_path: 'fam1/minutes/min1_72_png.png',
        thumbnail_status: 'ready',
      },
      id: 'min1',
    })
    // 1 ページ限定 + DPI72 + PNG で呼び出していること
    expect(renderMock).toHaveBeenCalledTimes(1)
    expect(renderMock.mock.calls[0][0]).toMatchObject({
      pageRange: { from: 1, to: 1 },
      requestedDpi: 72,
      format: 'png',
      asZip: false,
    })
  })

  it('upload エラー: markFailed + UPLOAD_FAILED', async () => {
    const { supabase, updates } = makeSupabase({
      minute: minimalMinute,
      template: minimalTemplate,
      uploadError: { message: 'rls denied' },
    })
    const res = await generateMinuteThumbnail(supabase as never, { minuteId: 'min1' })
    expect(res).toEqual({ ok: false, code: 'UPLOAD_FAILED' })
    expect(updates).toContainEqual({
      table: 'minutes',
      patch: { thumbnail_status: 'failed' },
      id: 'min1',
    })
  })

  it('render 例外: markFailed + RENDER_FAILED（1 回で failed 確定）', async () => {
    renderMock.mockRejectedValueOnce(new Error('boom'))
    const { supabase, updates } = makeSupabase({
      minute: minimalMinute,
      template: minimalTemplate,
    })
    const res = await generateMinuteThumbnail(supabase as never, { minuteId: 'min1' })
    expect(res).toEqual({ ok: false, code: 'RENDER_FAILED' })
    expect(updates).toContainEqual({
      table: 'minutes',
      patch: { thumbnail_status: 'failed' },
      id: 'min1',
    })
  })
})

describe('markMinuteThumbnailFailed', () => {
  it('minutes.thumbnail_status を failed に update する', async () => {
    const { supabase, updates } = makeSupabase({})
    await markMinuteThumbnailFailed(supabase as never, 'min1')
    expect(updates).toEqual([
      {
        table: 'minutes',
        patch: { thumbnail_status: 'failed' },
        id: 'min1',
      },
    ])
  })
})
