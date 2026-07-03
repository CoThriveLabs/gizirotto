'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { createSupabaseServiceClient } from '@/lib/supabase/service'
import { regenerateMinutePdf } from '@/lib/pdf-output/regenerate-minute-pdf'
import { PdfFieldSchemaZ } from '@/lib/ai/schemas/pdf-field-schema'
import { parseNewFields } from '@/lib/pdf-output/merge-template-and-new-fields'
import { mergeNewFieldsSnapshot } from '@/lib/pdf-output/merge-new-fields-snapshot'
import { contentSchema, fieldOverrideSchema } from './shared'

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
