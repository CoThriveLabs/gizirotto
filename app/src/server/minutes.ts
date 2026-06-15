'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { createSupabaseServiceClient } from '@/lib/supabase/service'
import { decodeAccessTokenClaims } from '@/lib/jwt-claims'
import { regenerateMinutePdf } from '@/lib/pdf-output/regenerate-minute-pdf'
import { PdfFieldSchemaZ } from '@/lib/ai/schemas/pdf-field-schema'
import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'
import { parseNewFields } from '@/lib/pdf-output/merge-template-and-new-fields'
import { mergeNewFieldsSnapshot } from '@/lib/pdf-output/merge-new-fields-snapshot'
import {
  loadBuiltinBboxOverrides,
  resolveBuiltinBboxSlugFromProcessedPath,
} from '@/lib/builtin-bbox-loader'
import {
  mapDbErrorToResourceLimit,
  ResourceLimitError,
} from '@/lib/db-error-mapper'

/**
 * 議事録 Server Action 群。
 *
 * 将来ゴミ箱導入時は schema を論理削除に書き換え予定（deleted_at 列追加 + 30 日 cron）。
 */

const MINUTES_PAGE_SIZE = 20

const contentSchema = z.record(z.string(), z.unknown())

const createMinuteSchema = z.object({
  templateId: z.string().uuid(),
  title: z.string().min(1).max(100),
  meetingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  content: contentSchema.refine(
    (v) => Object.keys(v).length > 0,
    { message: 'EMPTY_CONTENT' },
  ),
  sourceMode: z.enum(['A-1', 'A-2', 'B-2', 'imported']).optional(),
})

const updateMinuteSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(100).optional(),
  meetingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  content: contentSchema.optional(),
})

export type CreateMinuteInput = z.infer<typeof createMinuteSchema>
export type UpdateMinuteInput = z.infer<typeof updateMinuteSchema>

export type MinutesListItem = {
  id: string
  title: string
  meeting_date: string
  thumbnail_path: string | null
  thumbnail_status: string
  template_id: string | null
  template_name: string | null
  source_format: string | null
  signedThumbUrl: string | null
}

export type MinutesListResult = {
  items: MinutesListItem[]
  totalCount: number
  page: number
  pageSize: number
}

/**
 * 議事録一覧。月絞り + meeting_date 降順 + 20 件 / page。
 */
export async function listMinutes(options?: {
  month?: string
  page?: number
}): Promise<MinutesListResult> {
  const page = Math.max(1, options?.page ?? 1)
  const offset = (page - 1) * MINUTES_PAGE_SIZE

  const supabase = await createSupabaseServerClient()

  let query = supabase
    .from('minutes')
    .select(
      'id, title, meeting_date, thumbnail_path, thumbnail_status, template_id, template:templates(name, source_format)',
      { count: 'exact' },
    )
    .order('meeting_date', { ascending: false })
    .range(offset, offset + MINUTES_PAGE_SIZE - 1)

  if (options?.month && /^\d{4}-\d{2}$/.test(options.month)) {
    const [year, month] = options.month.split('-').map(Number)
    const start = new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10)
    const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
    query = query.gte('meeting_date', start).lte('meeting_date', end)
  }

  const { data, count, error } = await query
  if (error) throw error

  const items: MinutesListItem[] = await Promise.all(
    (data ?? []).map(async (row) => {
      const tpl = Array.isArray(row.template) ? row.template[0] : row.template
      let signedThumbUrl: string | null = null
      if (row.thumbnail_status === 'ready' && row.thumbnail_path) {
        const { data: signed } = await supabase.storage
          .from('image_cache')
          .createSignedUrl(row.thumbnail_path, 3600)
        signedThumbUrl = signed?.signedUrl ?? null
      }
      return {
        id: row.id,
        title: row.title,
        meeting_date: row.meeting_date,
        thumbnail_path: row.thumbnail_path,
        thumbnail_status: row.thumbnail_status,
        template_id: row.template_id,
        template_name: tpl?.name ?? null,
        source_format: tpl?.source_format ?? null,
        signedThumbUrl,
      }
    }),
  )

  return {
    items,
    totalCount: count ?? 0,
    page,
    pageSize: MINUTES_PAGE_SIZE,
  }
}

/**
 * 単一議事録取得（viewer + 編集画面共通）。
 */
export async function getMinutes(minutesId: string) {
  const supabase = await createSupabaseServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('UNAUTHENTICATED')

  const { data, error } = await supabase
    .from('minutes')
    .select(
      'id, family_id, template_id, title, meeting_date, content_json, bbox_overrides, new_fields, output_pdf_path, output_docx_path, thumbnail_path, thumbnail_status, source_mode, created_at, updated_at, template:templates(name, source_format)',
    )
    .eq('id', minutesId)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new Error('NOT_FOUND')
  return data
}

/**
 * 議事録新規作成。A-1 / A-2 / B-2 共通の最終保存口。
 */
export async function createMinute(input: CreateMinuteInput): Promise<{ id: string }> {
  const parsed = createMinuteSchema.parse(input)
  const supabase = await createSupabaseServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('UNAUTHENTICATED')

  const { data: sessionData } = await supabase.auth.getSession()
  const familyId = decodeAccessTokenClaims(sessionData.session?.access_token)?.family_id
  if (!familyId) throw new Error('NOT_IN_FAMILY')

  // builtin テンプレ判定（templates.family_id IS NULL かつ processed_path が seed 由来）の
  // 場合、HTML 実測 bbox JSON を minute.bbox_overrides に初期値として焼き込む。これにより
  // AdjustView 着地時に bbox 0 個ではなくサムネ同レイアウトで開ける。
  // user テンプレへは触れない。読込失敗時は bbox_overrides={} で挿入し白紙 A4 fallback へ。
  let initialBboxOverrides: Record<string, unknown> = {}
  {
    const { data: tplRow } = await supabase
      .from('templates')
      .select('family_id, processed_path')
      .eq('id', parsed.templateId)
      .maybeSingle()
    if (tplRow && tplRow.family_id === null) {
      const slug = resolveBuiltinBboxSlugFromProcessedPath(tplRow.processed_path)
      if (slug) {
        try {
          const loaded = await loadBuiltinBboxOverrides(slug)
          if (loaded) initialBboxOverrides = loaded
        } catch (e) {
          console.warn('[createMinute] builtin bbox load failed', {
            slug,
            error: (e as Error).message,
          })
        }
      }
    }
  }

  const insertPayload: Record<string, unknown> = {
    family_id: familyId,
    template_id: parsed.templateId,
    title: parsed.title,
    meeting_date: parsed.meetingDate,
    content_json: parsed.content,
    source_mode: parsed.sourceMode ?? null,
    created_by: user.id,
  }
  if (Object.keys(initialBboxOverrides).length > 0) {
    insertPayload.bbox_overrides = initialBboxOverrides
  }

  const { data, error } = await supabase
    .from('minutes')
    .insert(insertPayload)
    .select('id')
    .single()
  if (error) {
    // 議事録月次上限（DB trigger）を専用 Error にマップしてから throw。
    // それ以外の DB エラーは従来通り素通しで throw。
    const limit = mapDbErrorToResourceLimit(error)
    if (limit?.body.resource === 'minutes') {
      throw new ResourceLimitError('minutes')
    }
    throw error
  }

  // viewer は output_pdf_path 経由で content 反映済 PDF を画像化するため、
  // 議事録保存直後に overlay/simple PDF を生成しておく（失敗しても CRUD は成功させる）。
  // service client 経由: SSR client では builtin/ 配下 storage の RLS で download が
  // ブロックされる + cookie 経由 storage upload が握り潰される事象がある。
  const svc = createSupabaseServiceClient()
  const regen = await regenerateMinutePdf(svc, data.id)
  if (!regen.ok) {
    console.error('[createMinute] regenerateMinutePdf failed', {
      minuteId: data.id,
      reason: regen.reason,
    })
  }

  revalidatePath('/minutes')
  revalidatePath('/')
  return { id: data.id }
}

/**
 * 議事録更新。content 変更時は output_*_path を NULL リセット = 次回 viewer で再出力。
 */
export async function updateMinute(input: UpdateMinuteInput): Promise<{ id: string }> {
  const parsed = updateMinuteSchema.parse(input)
  const supabase = await createSupabaseServerClient()

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (parsed.title !== undefined) patch.title = parsed.title
  if (parsed.meetingDate !== undefined) patch.meeting_date = parsed.meetingDate
  if (parsed.content !== undefined) {
    patch.content_json = parsed.content
    patch.output_pdf_path = null
    patch.output_docx_path = null
  }

  const { data, error } = await supabase
    .from('minutes')
    .update(patch)
    .eq('id', parsed.id)
    .select('id')
    .single()
  if (error) throw error

  if (parsed.content !== undefined) {
    const svc = createSupabaseServiceClient()
    const regen = await regenerateMinutePdf(svc, parsed.id)
    if (!regen.ok) {
      console.error('[updateMinute] regenerateMinutePdf failed', {
        minuteId: parsed.id,
        reason: regen.reason,
      })
    }
  }

  revalidatePath('/minutes')
  revalidatePath(`/minutes/${parsed.id}`)
  // 保存後に閲覧画面 → AdjustView に戻った際の hydration バグ対策。
  // `revalidatePath('/minutes/[id]')` だけでは詳細画面のみ invalidate され、adjust 画面の
  // RSC スナップショットは古いまま（Router Cache 由来）。adjust 画面の path も明示 revalidate
  // して Router Cache を構造的に invalidate する。
  revalidatePath(`/minutes/${parsed.id}/adjust`)
  return { id: data.id }
}

/**
 * partial FieldOverride。x/y/w/h/fontSize すべて optional（旧 `{x,y}` のみ override も
 * 後方互換で valid）。w/h/fontSize は正の有限数のみ受け入れる。
 */
const fieldOverrideSchema = z
  .object({
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    w: z.number().finite().positive().optional(),
    h: z.number().finite().positive().optional(),
    fontSize: z.number().finite().positive().optional(),
  })
  .strict()

const bboxOverridesSchema = z.object({
  id: z.string().uuid(),
  overrides: z.record(z.string().min(1).max(100), fieldOverrideSchema),
})

export type SaveBboxOverridesInput = z.infer<typeof bboxOverridesSchema>

/**
 * 微調整 UI の保存口。
 * bbox_overrides は `{x?,y?,w?,h?,fontSize?}` partial（後方互換）。
 * RLS で自家族のみ可視 + UPDATE 可、output_*_path は invalidate して次回再出力で反映。
 */
export async function saveBboxOverrides(
  input: SaveBboxOverridesInput,
): Promise<{ ok: true }> {
  const parsed = bboxOverridesSchema.parse(input)
  const supabase = await createSupabaseServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('UNAUTHENTICATED')

  const { error } = await supabase
    .from('minutes')
    .update({
      bbox_overrides: parsed.overrides,
      output_pdf_path: null,
      output_docx_path: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', parsed.id)
  if (error) throw error

  const svc = createSupabaseServiceClient()
  const regen = await regenerateMinutePdf(svc, parsed.id)
  if (!regen.ok) {
    console.error('[saveBboxOverrides] regenerateMinutePdf failed', {
      minuteId: parsed.id,
      reason: regen.reason,
    })
  }

  revalidatePath(`/minutes/${parsed.id}`)
  // adjust 画面側の RSC スナップショット鮮度を必要とするため adjust path も invalidate する。
  revalidatePath(`/minutes/${parsed.id}/adjust`)
  return { ok: true }
}

/**
 * 統合 AdjustView 用の「値 + overrides + newFields」同時保存口。
 *
 * 統合エディタ AdjustView は「値・位置・大きさ」を 1 画面で編集し、1 トランザクション相当で
 * サーバへ送る。content と overrides を同時に保存することで個別更新による output_*_path
 * リセットが二重に走るのを避ける（regenerate も 1 回に集約）。
 *
 * - content 省略時: overrides のみ保存（saveBboxOverrides 同等）。
 * - overrides 省略時: content のみ保存（updateMinute 同等）。
 * - 両指定時: 同一 UPDATE で content_json + bbox_overrides を更新 → regenerate 1 回。
 *
 * newFields は AdjustView「項目を追加」機能で minute に後追い追加した PdfField[] を
 * `minutes.new_fields` jsonb 列に保存する。後方互換のため optional。
 *   - 省略時: 既存 new_fields は維持（partial update・触らない）。
 *   - `[]` 指定時: 全削除として new_fields = [] を書く。
 * 最大 20 件（FIELDS_MAX 同値・templates と整合）。
 */
const saveMinuteAdjustSchema = z.object({
  id: z.string().uuid(),
  content: contentSchema.optional(),
  overrides: z.record(z.string().min(1).max(100), fieldOverrideSchema).optional(),
  newFields: z.array(PdfFieldSchemaZ).max(20).optional(),
})

export type SaveMinuteAdjustInput = z.infer<typeof saveMinuteAdjustSchema>

export async function saveMinuteAdjust(
  input: SaveMinuteAdjustInput,
): Promise<{ ok: true }> {
  const parsed = saveMinuteAdjustSchema.parse(input)
  if (
    parsed.content === undefined &&
    parsed.overrides === undefined &&
    parsed.newFields === undefined
  ) {
    // 何も指定されないのは UI バグの兆候だが、no-op として成功扱い（regenerate しない）。
    return { ok: true }
  }

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('UNAUTHENTICATED')

  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    output_pdf_path: null,
    output_docx_path: null,
  }
  if (parsed.content !== undefined) patch.content_json = parsed.content
  if (parsed.overrides !== undefined) patch.bbox_overrides = parsed.overrides

  // newFields 指定時は mergeNewFieldsSnapshot 純関数で DB の現 new_fields と client snapshot
  // の差分を判定（INSERT / UPDATE / DELETE）。
  // 本関数を通すことで:
  //   - サーバ側で採番再確定（client 楽観名前が templates と衝突した場合のフォールバック）
  //   - bbox 範囲外 / label 不正のサーバ side ガード
  //   - 件数上限 20 のサーバ side ガード
  if (parsed.newFields !== undefined) {
    // minute → template_id → templates.fields / pageSizes を引いて merge 用入力を作る。
    const { data: minRow, error: mErr } = await supabase
      .from('minutes')
      .select('template_id, new_fields')
      .eq('id', parsed.id)
      .maybeSingle()
    if (mErr) throw mErr
    if (!minRow) throw new Error('NOT_FOUND')

    let templateNames: ReadonlySet<string> = new Set()
    if (minRow.template_id) {
      const { data: tplRow, error: tErr } = await supabase
        .from('templates')
        .select('fields')
        .eq('id', minRow.template_id)
        .maybeSingle()
      if (tErr) throw tErr
      if (tplRow) {
        templateNames = extractTemplateNames(tplRow.fields)
      }
    }

    // pageSizes は templates テーブルに列が無いため、サーバ側は緩めの範囲（A4 portrait + 余裕）で
    // チェックする。厳密 bbox 範囲チェックはクライアント側（AdjustView）で BboxPane が pageSizes を
    // 持って範囲外 drag を阻止しており、サーバ側はサニティチェック + 採番再確定のみで責務十分。
    const pagesInPayload = new Set<number>()
    for (const nf of parsed.newFields) pagesInPayload.add(nf.bbox.page)
    const pageSizes: { page: number; widthPt: number; heightPt: number; pixelWidth: number; pixelHeight: number }[] = []
    for (const p of pagesInPayload) {
      pageSizes.push({ page: p, widthPt: 9999, heightPt: 9999, pixelWidth: 9999, pixelHeight: 9999 })
    }

    const dbNewFields = parseNewFields(minRow.new_fields)
    // client snapshot 形式に正規化（PdfField → NewFieldSnapshotItem に必要なフィールドだけ抜く）。
    const clientSnapshot = parsed.newFields.map((nf) => ({
      name: nf.name,
      label: nf.label,
      bbox: nf.bbox,
      multiline: nf.multiline,
      // DB に既存 name なら UPDATE、無ければ INSERT（isNew=undefined で振り分けは関数内）。
    }))
    const merged = mergeNewFieldsSnapshot(
      dbNewFields,
      clientSnapshot,
      templateNames,
      pageSizes,
    )
    if (!merged.ok) {
      // 入力不正は zod でほぼ弾けるが、bbox 範囲超え / 採番失敗 / 件数超過はここで検知。
      throw new Error(`SAVE_NEW_FIELDS_FAILED:${merged.error}`)
    }
    patch.new_fields = merged.newFields
  }

  // `.update(patch).eq('id', parsed.id)` だけだと RLS が UPDATE を全件除外した場合に
  // PostgREST は 0 件成功（error=null・data=[]）で返してくる。UI 側は「保存成功」と判定し
  // reload しても DB 値は更新されておらず「全消え」のように見える。
  //   - 対策: `.select('id').maybeSingle()` で更新後行を取得し、null なら明示エラーを投げる。
  //   - 行 0 件（id 不一致 / RLS 拒否等）→ 'MINUTE_UPDATE_NOT_PERSISTED'
  // これによりサイレント失敗が UI 上で error toast として可視化される。
  const { data: updated, error } = await supabase
    .from('minutes')
    .update(patch)
    .eq('id', parsed.id)
    .select('id')
    .maybeSingle()
  if (error) throw error
  if (!updated) {
    // RLS 拒否 or id 不一致による無音 0 件更新を明示化。
    throw new Error('MINUTE_UPDATE_NOT_PERSISTED')
  }

  const svc = createSupabaseServiceClient()
  const regen = await regenerateMinutePdf(svc, parsed.id)
  if (!regen.ok) {
    console.error('[saveMinuteAdjust] regenerateMinutePdf failed', {
      minuteId: parsed.id,
      reason: regen.reason,
    })
  }

  revalidatePath(`/minutes/${parsed.id}`)
  // AdjustView 保存後に詳細画面 → AdjustView へ戻った際、Router Cache の adjust segment に
  // 残った古い RSC が hydrate されて bbox 空表示になる現象の対策。adjust の path も明示
  // revalidate して Router Cache を invalidate する（user/builtin 両経路に効く）。
  revalidatePath(`/minutes/${parsed.id}/adjust`)
  return { ok: true }
}

/**
 * saveMinuteAdjust 内で templates.fields から name 集合を抽出するヘルパ。
 * 旧 ARRAY 形式 / 新 {fields:[]} 形式の両対応。
 */
function extractTemplateNames(raw: unknown): ReadonlySet<string> {
  if (!raw) return new Set()
  const fieldsArr: unknown = Array.isArray(raw)
    ? raw
    : typeof raw === 'object'
      ? (raw as { fields?: unknown }).fields
      : null
  if (!Array.isArray(fieldsArr)) return new Set()
  const out = new Set<string>()
  for (const f of fieldsArr) {
    if (!f || typeof f !== 'object') continue
    const name = (f as { name?: unknown }).name
    if (typeof name === 'string' && name.length > 0) out.add(name)
  }
  return out
}

/**
 * 議事録物理削除（RPC delete_minute_with_files 経由）。
 * RPC が family_id 認可 + DB rows + storage オブジェクト一括削除を atomic 実行。
 * 将来ゴミ箱導入時は RPC を論理削除に書き換え予定。
 */
export async function deleteMinute(minuteId: string): Promise<{ ok: true }> {
  if (!/^[0-9a-f-]{36}$/i.test(minuteId)) throw new Error('INVALID_ID')

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('UNAUTHENTICATED')

  const { error } = await supabase.rpc('delete_minute_with_files', {
    p_minute_id: minuteId,
  })
  if (error) {
    const msg = error.message ?? ''
    if (msg.includes('NOT_AUTHORIZED')) throw new Error('NOT_AUTHORIZED')
    throw error
  }

  revalidatePath('/minutes')
  revalidatePath('/')
  return { ok: true }
}
