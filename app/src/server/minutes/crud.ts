'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { createSupabaseServiceClient } from '@/lib/supabase/service'
import { decodeAccessTokenClaims } from '@/lib/jwt-claims'
import { regenerateMinutePdf } from '@/lib/pdf-output/regenerate-minute-pdf'
import {
  loadBuiltinBboxOverrides,
  resolveBuiltinBboxSlugFromProcessedPath,
} from '@/lib/builtin-bbox-loader'
import { mapDbErrorToResourceLimit, ResourceLimitError } from '@/lib/db-error-mapper'
import { contentSchema } from './shared'

/**
 * 議事録 Server Action 群。
 *
 * 将来ゴミ箱導入時は schema を論理削除に書き換え予定（deleted_at 列追加 + 30 日 cron）。
 */

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
  excludeFromLearning: z.boolean().optional(),
})

export type CreateMinuteInput = z.infer<typeof createMinuteSchema>
export type UpdateMinuteInput = z.infer<typeof updateMinuteSchema>

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
      'id, family_id, template_id, title, meeting_date, content_json, bbox_overrides, new_fields, output_pdf_path, output_docx_path, thumbnail_path, thumbnail_status, source_mode, exclude_from_learning, created_at, updated_at, template:templates(name, source_format)',
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
  if (parsed.excludeFromLearning !== undefined) {
    patch.exclude_from_learning = parsed.excludeFromLearning
  }
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
