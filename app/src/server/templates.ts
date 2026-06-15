'use server'

import { z } from 'zod'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { getParser } from '@/lib/parsers'
import { extractTemplateStructure } from '@/lib/ai/structure-extractor'
import { generatePlaceholderDocx } from '@/lib/ai/template-processor'
import { decodeAccessTokenClaims } from '@/lib/jwt-claims'
import { convertDocxToBlankPdf } from '@/lib/cloudconvert'
import { analyzePdfFull } from '@/lib/parsers/pdf/analyze-pipeline'
import { generateTemplateThumbnail } from '@/lib/pdf-output/template-thumbnail'
import type { TemplateField } from '@/lib/ai/schemas/template-schema'
import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'
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
import {
  mapDbErrorToResourceLimit,
  ResourceLimitError,
} from '@/lib/db-error-mapper'

const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10MB（家族議事録テンプレで十分余裕）

// §4-4: jsonb 格納フィールドの discriminated union（union 全体を表す型）。
// 判別子は bbox の有無（PdfField のみ bbox を持つ）。
type TemplateFieldForDb = TemplateField | PdfField

const uploadSchema = z.object({
  name: z.string().min(1).max(40),
  format: z.enum(['docx', 'pdf']),
  fileBase64: z.string().min(1),
  // 仕様書 v1.6.1 §0-3.5 要件 1 / 設計書 v1.4.2 §3-6-b: アップロード UI の経路選択。
  // PDF 専用、docx では無視。
  //   'A' (default): 未書込原本 → そのまま _blank.pdf にコピー（既存挙動）
  //   'B':           書込済 → アップロード後に /whiteout-preview + /whiteout-apply で白塗り化
  inputPathType: z.enum(['A', 'B']).optional(),
})

export type UploadTemplateInput = z.infer<typeof uploadSchema>

const CONTENT_TYPE: Record<'docx' | 'pdf', string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
}

const PROCESSED_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/**
 * テンプレを Word/PDF からアップロード。
 * 1. パース → 中間形式
 * 2. Claude で構造抽出（TemplateSchema）
 * 3. placeholder docx 生成
 * 4. Storage に raw / processed 保存
 * 5. templates テーブルに INSERT
 */
export async function uploadTemplate(input: UploadTemplateInput) {
  const { name, format, fileBase64, inputPathType: requestedPath } =
    uploadSchema.parse(input)
  const supabase = await createSupabaseServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('UNAUTHENTICATED')

  const { data: sessionData } = await supabase.auth.getSession()
  const familyId = decodeAccessTokenClaims(sessionData.session?.access_token)?.family_id
  if (!familyId) throw new Error('NOT_IN_FAMILY')

  const fileBuf = Buffer.from(fileBase64, 'base64')
  if (fileBuf.byteLength === 0) throw new Error('EMPTY_FILE')
  if (fileBuf.byteLength > MAX_FILE_BYTES) throw new Error('FILE_TOO_LARGE')

  // 1. パース
  const parser = getParser(format)
  const intermediate = await parser.parse(
    fileBuf.buffer.slice(
      fileBuf.byteOffset,
      fileBuf.byteOffset + fileBuf.byteLength,
    ),
  )

  // 2. 構造抽出
  //    docx は従来どおり汎用 TemplateSchema 抽出。
  //    PDF は placeholder docx 生成のため schema は引き続き作るが、
  //    DB に格納する fields は後段の PDF 専用パイプライン（analyzePdfFull）で
  //    bbox 付き実構造に差し替える（N-6 配線、2026-05-29）。
  const schema = await extractTemplateStructure(intermediate)

  // 3. placeholder docx 生成
  const processedDocx = await generatePlaceholderDocx(schema, name)

  // DB に入れる fields。docx は schema.fields、PDF は analyzePdfFull の結果で上書きする。
  // jsonb カラムなので docx(TemplateField) / pdf(PdfField) の discriminated union を許容（§4-4）。
  let fieldsForDb: TemplateFieldForDb[] = schema.fields

  // 4. Storage 保存
  const templateId = crypto.randomUUID()
  const rawPath = `${familyId}/${templateId}.${format}`
  const processedPath = `${familyId}/${templateId}_processed.docx`

  const rawUpload = await supabase.storage
    .from('templates_raw')
    .upload(rawPath, new Blob([new Uint8Array(fileBuf)]), {
      contentType: CONTENT_TYPE[format],
      upsert: false,
    })
  if (rawUpload.error) throw rawUpload.error

  const processedUpload = await supabase.storage
    .from('templates_processed')
    .upload(processedPath, new Blob([new Uint8Array(processedDocx)]), {
      contentType: PROCESSED_CONTENT_TYPE,
      upsert: false,
    })
  if (processedUpload.error) throw processedUpload.error

  // 4-b. PDF テンプレ専用: 入力経路 A / B 分岐（設計書 v1.4.2 §3-6-b / 仕様書 §0-3.5 要件 1）
  //
  //   - パス A（未書込原本、デフォルト）: raw PDF を `_blank.pdf` にコピー →
  //     blank_pdf_status='ready' で即利用可。
  //   - パス B（書込済 → 白塗り化）: raw PDF のみ保存し、`_blank.pdf` は未生成。
  //     blank_pdf_status='pending_whiteout' を立て、UI で /whiteout-preview →
  //     /whiteout-apply を呼び出して塗り後の PDF を後段で生成する。
  //
  // 仕様書 §0-3.5 要件 4 著作権予防策の最低限。
  // 今は upload 自体を同意行為とみなして agreed_at = now() を記録。
  let backgroundPdfPath: string | null = null
  let inputPathType: 'A' | 'B' | null = null
  let licenseConsent: { user_id: string; agreed_at: string } | null = null
  if (format === 'pdf') {
    inputPathType = requestedPath ?? 'A'
    licenseConsent = { user_id: user.id, agreed_at: new Date().toISOString() }

    // N-6 配線 (2026-05-29): PDF は汎用テキスト構造抽出でなく PDF 専用パイプラインで
    // bbox 付き実フィールドを抽出する。これまで Phase 2.5 の classifier / extractor /
    // field-semantic が export 済なのに uploadTemplate から呼ばれず、PDF も docx 汎用経路に
    // 落ちて「日付/参加者/議題…」の汎用 5 項目にフォールバックしていた真因を解消する。
    // 失敗時は汎用 schema.fields にフォールバックして upload 自体は通す（劣化はするが落とさない）。
    try {
      const analyzeBytes = new Uint8Array(fileBuf.byteLength)
      analyzeBytes.set(fileBuf)
      const analyzed = await analyzePdfFull({
        pdfBytes: analyzeBytes,
        inputPathType,
      })
      if (analyzed.fields.length > 0) {
        fieldsForDb = analyzed.fields
      }
    } catch (e) {
      console.error(
        '[N-6 upload] analyzePdfFull failed, fallback to generic schema.fields:',
        e instanceof Error ? e.message : String(e),
      )
    }

    if (inputPathType === 'A') {
      backgroundPdfPath = `${familyId}/${templateId}_blank.pdf`
      const blankUpload = await supabase.storage
        .from('templates_processed')
        .upload(backgroundPdfPath, new Blob([new Uint8Array(fileBuf)]), {
          contentType: CONTENT_TYPE.pdf,
          upsert: false,
        })
      if (blankUpload.error) throw blankUpload.error
    }
    // パス B: backgroundPdfPath は null のまま。後段の /whiteout-apply で書き戻す
  }

  // 5. DB INSERT
  const { data, error } = await supabase
    .from('templates')
    .insert({
      id: templateId,
      family_id: familyId,
      name,
      source_format: format,
      source_path: rawPath,
      processed_path: processedPath,
      fields: fieldsForDb,
      is_default: false,
      created_by: user.id,
      background_pdf_path: backgroundPdfPath,
      input_path_type: inputPathType,
      license_consent: licenseConsent,
    })
    .select()
    .single()
  if (error) {
    // テンプレ累積上限（DB trigger）を専用 Error にマップしてから throw。
    // クライアントは ResourceLimitError を catch して LimitModal を表示する想定。
    // それ以外の DB エラーは従来通り素通し。
    const limit = mapDbErrorToResourceLimit(error)
    if (limit?.body.resource === 'templates') {
      throw new ResourceLimitError('templates')
    }
    throw error
  }

  // 6. docx テンプレは CloudConvert で blank PDF 化
  // pdf パス A は _blank.pdf 保存済 → 'ready'
  // pdf パス B は _blank.pdf 未生成（UI 主導の白塗り待ち）→ 'pending_whiteout'
  if (format === 'pdf') {
    await supabase
      .from('templates')
      .update({
        blank_pdf_status: inputPathType === 'B' ? 'pending_whiteout' : 'ready',
      })
      .eq('id', templateId)

    // パス A は blank PDF が確定済なので即サムネ生成。
    // パス B は白塗り適用（/whiteout-apply）後に生成するため upload 時はスキップ。
    // 失敗してもサムネ status='failed' を記録するのみで upload は落とさない。
    if (inputPathType === 'A') {
      const thumbBytes = new Uint8Array(fileBuf.byteLength)
      thumbBytes.set(fileBuf)
      await generateTemplateThumbnail(supabase, {
        familyId,
        templateId,
        pdfBytes: thumbBytes,
      })
    }
  } else {
    // docx 経路: CloudConvert API 呼出（失敗時は擬人化エラーで client に伝播）
    try {
      const blankPdfBuffer = await convertDocxToBlankPdf(fileBuf, `${name}.docx`)
      const blankPdfPath = `${familyId}/${templateId}_blank.pdf`
      const blankUpload = await supabase.storage
        .from('templates_processed')
        .upload(blankPdfPath, new Blob([new Uint8Array(blankPdfBuffer)]), {
          contentType: CONTENT_TYPE.pdf,
          upsert: false,
        })
      if (blankUpload.error) throw blankUpload.error
      await supabase
        .from('templates')
        .update({
          blank_pdf_status: 'ready',
          background_pdf_path: blankPdfPath,
        })
        .eq('id', templateId)
    } catch {
      await supabase
        .from('templates')
        .update({ blank_pdf_status: 'failed' })
        .eq('id', templateId)
      throw new Error('CLOUDCONVERT_UPLOAD_FAILED')
    }
  }

  return data
}

/**
 * 関連件数（議事録 / チャットセッション）を返す。modal 表示時に使う。
 * RLS により自家族範囲しか count されない前提。
 */
export async function countTemplateRefs(templateId: string) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('UNAUTHENTICATED')

  const [minutesRes, chatRes] = await Promise.all([
    supabase
      .from('minutes')
      .select('id', { count: 'exact', head: true })
      .eq('template_id', templateId),
    supabase
      .from('chat_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('template_id', templateId),
  ])
  if (minutesRes.error) throw minutesRes.error
  if (chatRes.error) throw chatRes.error
  return {
    minutes: minutesRes.count ?? 0,
    chatSessions: chatRes.count ?? 0,
  }
}

export type DeleteTemplateMode = 'template_only' | 'with_minutes'

/**
 * 削除（自家族の自前テンプレのみ。デフォルトは RLS でブロック）。
 * mode:
 *   - 'template_only': 関連 minutes / chat_sessions は残し template_id を NULL に（DB 側 FK ON DELETE SET NULL に任せる）
 *   - 'with_minutes' : 関連 minutes を delete_minute_with_files RPC で物理削除 →
 *                      残った minute_id=NULL の chat_sessions も削除 → templates DELETE
 * Storage 側の raw / processed も合わせて削除する（取りこぼし許容、DB 削除を主とする）。
 */
export async function deleteTemplate(
  templateId: string,
  mode: DeleteTemplateMode = 'template_only',
) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('UNAUTHENTICATED')

  // 先に対象テンプレの path を取得（RLS で自家族 + is_default=false のみ見える前提）
  const { data: target, error: selectError } = await supabase
    .from('templates')
    .select('id, source_path, processed_path, is_default')
    .eq('id', templateId)
    .single()
  if (selectError) throw selectError
  if (target.is_default) throw new Error('CANNOT_DELETE_DEFAULT')

  if (mode === 'with_minutes') {
    // 関連 minutes を物理削除（storage 出力含む / minute_id 紐付き chat_sessions も連鎖削除）
    const { data: relatedMinutes, error: listErr } = await supabase
      .from('minutes')
      .select('id')
      .eq('template_id', templateId)
    if (listErr) throw listErr
    for (const m of relatedMinutes ?? []) {
      const { error: rpcErr } = await supabase.rpc('delete_minute_with_files', {
        p_minute_id: m.id,
      })
      if (rpcErr) throw rpcErr
    }
    // 議事録未保存の chat_sessions（minute_id IS NULL）も削除
    const { error: chatErr } = await supabase
      .from('chat_sessions')
      .delete()
      .eq('template_id', templateId)
    if (chatErr) throw chatErr
  }
  // mode === 'template_only' の場合は FK ON DELETE SET NULL に任せる

  if (target.source_path) {
    await supabase.storage.from('templates_raw').remove([target.source_path])
  }
  if (target.processed_path && !target.processed_path.startsWith('builtin/')) {
    await supabase.storage
      .from('templates_processed')
      .remove([target.processed_path])
  }

  const { error: deleteError } = await supabase
    .from('templates')
    .delete()
    .eq('id', templateId)
  if (deleteError) throw deleteError
  return { ok: true }
}

/**
 * 自家族の templates 一覧 + デフォルトテンプレを取得。
 * RLS により自家族 + family_id IS NULL（builtin）のみ返る。
 */
export async function listTemplates() {
  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase
    .from('templates')
    .select(
      'id, name, source_format, processed_path, fields, is_default, created_at, thumbnail_path, thumbnail_status',
    )
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

/**
 * テンプレ一覧 + 各テンプレの thumbnail signed URL を付与。
 * thumbnail_status='ready' かつ thumbnail_path が存在する場合のみ signed URL を生成。
 * Phase 5a §1-3 テンプレカード UI 用。
 */
export async function listTemplatesWithThumbs() {
  const supabase = await createSupabaseServerClient()
  const templates = await listTemplates()
  const withThumbs = await Promise.all(
    templates.map(async (t) => {
      let signedThumbUrl: string | null = null
      if (t.thumbnail_status === 'ready' && t.thumbnail_path) {
        const { data } = await supabase.storage
          .from('image_cache')
          .createSignedUrl(t.thumbnail_path, 3600)
        signedThumbUrl = data?.signedUrl ?? null
      }
      return { ...t, signedThumbUrl }
    }),
  )
  return withThumbs
}

/**
 * 単一テンプレ取得。
 */
export async function getTemplate(templateId: string) {
  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase
    .from('templates')
    .select('*')
    .eq('id', templateId)
    .single()
  if (error) throw error
  return data
}

/**
 * bbox エディタの保存（G2-1 §4-2/§4-3/§4-4 ＋ グループB Phase B-1 §1-2）。
 *
 * グループB で「全 field スナップショット送信＋差分判定（UPDATE/DELETE/INSERT）」へ拡張。
 * 後方互換: 現行クライアントが {name,bbox}[] を送る間は全件 UPDATE になり従来同等に通る
 * （label/isNew は任意）。追加/分割/削除は後続フェーズの UI が isNew/labelDirty を付けて送る。
 *
 * - UPDATE: bbox のみ差替（label/type/font/padding 等は現 DB 値を温存。labelDirty 時のみ label 差替）。
 * - DELETE: スナップショットに無い既存 field を除外。
 * - INSERT: isNew の新 field を §2-4 デフォルト補完で生成・name 衝突はサーバ再採番。
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

  // 入力バリデーション（name + bbox ＋任意の label/isNew/labelDirty。§1-2）。
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

  // 楽観ロック: 保存直前の現 DB fields ハッシュとクライアント送付版を比較（§4-3）。
  //
  // ⚠ TOCTOU 既知（差し戻し-2）: この check（select→ハッシュ）と後段の .update() は
  // 別クエリのため、ハッシュ再取得〜UPDATE 間に並行更新が割り込む理論窓がある。
  // 家族内・単一テンプレ・低頻度編集の前提では実害は極小（同一テンプレを別々の人が
  // ミリ秒差で保存するケースは現実にはほぼ起きない）。
  // 将来 atomic 化するなら、条件付き UPDATE（fields ハッシュを WHERE 条件に持つ RPC、
  // 例: PostgREST 経由の RPC で row lock しつつ比較→更新）へ移行する候補。
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
 *   - 🚨 computeFieldsVersion の楽観ロックは発火させない（fixed_texts は fields に乗らない・§3-1）。
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
