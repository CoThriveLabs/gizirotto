'use server'

import { createSupabaseServerClient } from '@/lib/supabase/server'
import {
  FieldsSnapshotPayloadSchema,
  mergeFieldsSnapshot,
  type FieldSnapshotItem,
} from '@/lib/pdf-output/bbox-save'
import { computeFieldsVersion } from '@/lib/pdf-output/fields-version'
import { loadPageSizesOnly } from '@/lib/pdf-output/bbox-editor-data'
import type { WhiteoutBox } from '@/lib/parsers/pdf/whiteout-pipeline'
import {
  FixedTextsPayloadSchema,
  buildFixedTexts,
  type FixedTextItem,
} from '@/lib/pdf-output/fixedtext-save'
import type { Json } from '@/lib/supabase/database.types'

/**
 * bbox エディタの保存。
 *
 * 「全 field スナップショット送信＋差分判定（UPDATE/DELETE/INSERT）」方式。
 * 後方互換: クライアントが {name,bbox}[] のみ送る場合は全件 UPDATE になり従来同等に通る
 * （label/isNew は任意）。
 *
 * - UPDATE: bbox のみ差替（label/type/font/padding 等は現 DB 値を温存。labelDirty 時のみ label 差替）。
 * - DELETE: スナップショットに無い既存 field を除外。
 * - INSERT: isNew の新 field をデフォルト補完で生成・name 衝突はサーバ再採番。
 * - bbox がページ範囲内・w/h>0（範囲は background PDF の pageSizes で判定）。
 * - 反映後件数 min1/max20（FIELD_COUNT_OUT_OF_RANGE）・label 1-40（INVALID_LABEL）。
 * - 楽観ロック: 保存直前に現 DB fields を再取得しハッシュ再計算、
 *   クライアント送付 fieldsVersion と不一致なら CONFLICT で上書きしない（無改変）。
 * - RLS で自家族・非 default のみ更新可（default は明示拒否）。
 *
 * 戻り値は擬人化エラーのため throw する Error の message を CONFLICT/権限/範囲/件数で分岐。
 */
export async function updateTemplateFieldsBbox(
  templateId: string,
  updatedFields: FieldSnapshotItem[],
  fieldsVersion: string,
) {
  const supabase = await createSupabaseServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('UNAUTHENTICATED')

  // 入力バリデーション（name + bbox ＋任意の label/isNew/labelDirty）。
  const snapshot = FieldsSnapshotPayloadSchema.parse(updatedFields)

  // 現 DB テンプレ取得（RLS で自家族 + builtin のみ可視）。
  const { data: template, error: tplErr } = await supabase
    .from('templates')
    .select(
      'id, family_id, is_default, source_format, source_path, background_pdf_path, whiteout_boxes, fields',
    )
    .eq('id', templateId)
    .maybeSingle()
  if (tplErr) throw new Error('DB_ERROR')
  if (!template) throw new Error('NOT_FOUND')
  if (template.is_default) throw new Error('CANNOT_EDIT_DEFAULT')
  if (template.source_format !== 'pdf' || !template.background_pdf_path) {
    throw new Error('NOT_A_PDF_TEMPLATE')
  }

  const dbFields = Array.isArray(template.fields)
    ? (template.fields as unknown[])
    : []

  // 楽観ロック: 保存直前の現 DB fields ハッシュとクライアント送付版を比較。
  //
  // ⚠ TOCTOU 既知: この check（select→ハッシュ）と後段の .update() は
  // 別クエリのため、ハッシュ再取得〜UPDATE 間に並行更新が割り込む理論窓がある。
  // 家族内・単一テンプレ・低頻度編集の前提では実害は極小（同一テンプレを別々の人が
  // ミリ秒差で保存するケースは現実にはほぼ起きない）。
  // 将来 atomic 化するなら、条件付き UPDATE（fields ハッシュを WHERE 条件に持つ RPC）へ移行。
  const currentVersion = computeFieldsVersion(dbFields)
  if (currentVersion !== fieldsVersion) {
    throw new Error('CONFLICT')
  }

  // 範囲チェック用 pageSizes（background PDF をラスタライズ、OCR は呼ばない）。
  const pageSizes = await loadPageSizesOnly(
    supabase,
    template.background_pdf_path as string,
    {
      whiteoutBoxes: Array.isArray(template.whiteout_boxes)
        ? (template.whiteout_boxes as unknown as WhiteoutBox[])
        : null,
      sourcePath: (template.source_path as string | null) ?? null,
    },
  )

  // スナップショット差分（UPDATE/DELETE/INSERT）を反映した fields を組み立て
  // （範囲・他属性温存・件数 min1/max20・label・採番再検証を含む）。
  const merged = mergeFieldsSnapshot(dbFields, snapshot, pageSizes)
  if (!merged.ok) {
    throw new Error(merged.error)
  }

  const { data: updated, error: updErr } = await supabase
    .from('templates')
    .update({ fields: merged.fields })
    .eq('id', templateId)
    .select('id, fields')
    .single()
  if (updErr) throw new Error('SAVE_FAILED')

  // 保存後の新 fieldsVersion を返す（クライアントが連続保存できるよう更新）。
  return {
    ok: true as const,
    fieldsVersion: computeFieldsVersion(updated.fields),
  }
}

/**
 * 固定テキストの保存。
 *
 * templates.fixed_texts（jsonb）を独立に更新する専用 Server Action。
 *   - 入力検証（zod FixedTextSchema 配列）＋ buildFixedTexts（空 value 除外・bbox 範囲・件数20）。
 *   - 🚨 fields / whiteout_boxes には一切触れない（カラム独立保存）。
 *   - 🚨 computeFieldsVersion の楽観ロックは発火させない（fixed_texts は fields に乗らない）。
 *   - RLS で自家族・非 default のみ更新可（default は明示拒否）。
 *
 * 戻り値は擬人化エラーのため throw する Error の message を権限/範囲/件数で分岐。
 */
export async function updateTemplateFixedTexts(
  templateId: string,
  items: FixedTextItem[],
) {
  const supabase = await createSupabaseServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('UNAUTHENTICATED')

  // 入力バリデーション（name + value + bbox ＋任意 font。空 value は後段で除外）。
  const payload = FixedTextsPayloadSchema.parse(items)

  // 現 DB テンプレ取得（RLS で自家族 + builtin のみ可視）。fields/whiteout_boxes は読むだけ（不変）。
  const { data: template, error: tplErr } = await supabase
    .from('templates')
    .select(
      'id, family_id, is_default, source_format, source_path, background_pdf_path, whiteout_boxes',
    )
    .eq('id', templateId)
    .maybeSingle()
  if (tplErr) throw new Error('DB_ERROR')
  if (!template) throw new Error('NOT_FOUND')
  if (template.is_default) throw new Error('CANNOT_EDIT_DEFAULT')
  if (template.source_format !== 'pdf' || !template.background_pdf_path) {
    throw new Error('NOT_A_PDF_TEMPLATE')
  }

  // 範囲チェック用 pageSizes（background PDF をラスタライズ、OCR は呼ばない）。
  const pageSizes = await loadPageSizesOnly(
    supabase,
    template.background_pdf_path as string,
    {
      whiteoutBoxes: Array.isArray(template.whiteout_boxes)
        ? (template.whiteout_boxes as unknown as WhiteoutBox[])
        : null,
      sourcePath: (template.source_path as string | null) ?? null,
    },
  )

  // 空 value 除外・bbox 範囲・件数20・ft_N 安定採番・font 既定補完。
  const built = buildFixedTexts(payload, pageSizes)
  if (!built.ok) {
    throw new Error(built.error)
  }

  // fixed_texts カラムのみ更新（fields / whiteout_boxes は WHERE/SET 共に触れない）。
  const { error: updErr } = await supabase
    .from('templates')
    .update({ fixed_texts: built.fixedTexts as unknown as Json })
    .eq('id', templateId)
  if (updErr) throw new Error('SAVE_FAILED')

  return { ok: true as const, count: built.fixedTexts.length }
}
