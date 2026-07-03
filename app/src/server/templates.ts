'use server'

import { z } from 'zod'
import { headers } from 'next/headers'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { getParser } from '@/lib/parsers'
import { extractTemplateStructure } from '@/lib/ai/structure-extractor'
import { generatePlaceholderDocx } from '@/lib/ai/template-processor'
import { decodeAccessTokenClaims } from '@/lib/jwt-claims'
import { convertDocxToBlankPdf } from '@/lib/cloudconvert'
import { analyzePdfFull } from '@/lib/parsers/pdf/analyze-pipeline'
import { imageToA4Pdf } from '@/lib/parsers/image/image-to-pdf'
import { generateTemplateThumbnail } from '@/lib/pdf-output/template-thumbnail'
import { renderPdfToImages, getPdfNumPages } from '@/lib/pdf-output/image-render-worker'
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
import { ipBurstLimit, guestTemplateLimit } from '@/lib/ratelimit'
import { verifyTurnstile } from '@/lib/turnstile'
import { getClientIpFromHeaders } from '@/lib/client-ip'

const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10MB（家族議事録テンプレで十分余裕）

// jsonb 格納フィールドの discriminated union（union 全体を表す型）。
// 判別子は bbox の有無（PdfField のみ bbox を持つ）。
type TemplateFieldForDb = TemplateField | PdfField

const uploadSchema = z.object({
  name: z.string().min(1).max(40),
  format: z.enum(['docx', 'pdf', 'image']),
  fileBase64: z.string().min(1),
  // PDF/image 専用、docx では無視。
  //   'A' (default): 未書込原本 → そのまま _blank.pdf にコピー（既存挙動）
  //   'B':           書込済 → アップロード後に /whiteout-preview + /whiteout-apply で白塗り化
  inputPathType: z.enum(['A', 'B']).optional(),
  // image format のときのみ必須。
  imageMime: z.enum(['image/jpeg', 'image/png', 'image/webp']).optional(),
}).superRefine((val, ctx) => {
  if (val.format === 'image' && !val.imageMime) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'imageMime is required when format is image',
      path: ['imageMime'],
    })
  }
})

export type UploadTemplateInput = z.infer<typeof uploadSchema>

const CONTENT_TYPE: Record<'docx' | 'pdf' | 'image', string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  image: 'application/pdf',
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
  const { name, format, fileBase64, inputPathType: requestedPath, imageMime } =
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

  // 画像テンプレ経路: 元画像を PDF 変換してから PDF 経路に合流する。
  // 以降の Storage/DB 処理はすべて PDF として扱う（source_format='pdf', origin_format='image'）。
  let effectiveFileBuf = fileBuf
  let originFormat: string | null = null
  let imageRawExt: string | null = null

  if (format === 'image') {
    const imageBytes = new Uint8Array(fileBuf.byteLength)
    imageBytes.set(fileBuf)
    const pdfBytes = await imageToA4Pdf(
      imageBytes,
      imageMime as 'image/jpeg' | 'image/png' | 'image/webp',
    )
    effectiveFileBuf = Buffer.from(pdfBytes)
    originFormat = 'image'
    // 元画像の拡張子を MIME から決定
    imageRawExt = imageMime === 'image/jpeg' ? 'jpg' : imageMime === 'image/png' ? 'png' : 'webp'
  }

  // image は内部的に pdf として処理する
  const effectiveFormat = format === 'image' ? 'pdf' : format

  // 1. パース
  const parser = getParser(effectiveFormat)
  const intermediate = await parser.parse(
    effectiveFileBuf.buffer.slice(
      effectiveFileBuf.byteOffset,
      effectiveFileBuf.byteOffset + effectiveFileBuf.byteLength,
    ),
  )

  // 2. 構造抽出
  //    docx は従来どおり汎用 TemplateSchema 抽出。
  //    PDF / image は placeholder docx 生成のため schema は引き続き作るが、
  //    DB に格納する fields は後段の PDF 専用パイプライン（analyzePdfFull）で
  //    bbox 付き実構造に差し替える。
  const schema = await extractTemplateStructure(intermediate)

  // 3. placeholder docx 生成
  const processedDocx = await generatePlaceholderDocx(schema, name)

  // DB に入れる fields。docx は schema.fields、PDF/image は analyzePdfFull の結果で上書きする。
  let fieldsForDb: TemplateFieldForDb[] = schema.fields

  // 4. Storage 保存
  const templateId = crypto.randomUUID()
  // image は元画像を raw に保存し、変換 PDF は processed に保存する
  const rawPath =
    format === 'image' && imageRawExt
      ? `${familyId}/${templateId}.${imageRawExt}`
      : `${familyId}/${templateId}.${effectiveFormat}`
  const processedPath = `${familyId}/${templateId}_processed.docx`

  // 元ファイル（image の場合は元画像バイト）を raw に保存
  const rawBlob =
    format === 'image'
      ? new Blob([new Uint8Array(fileBuf)])
      : new Blob([new Uint8Array(effectiveFileBuf)])
  const rawContentType =
    format === 'image' ? (imageMime as string) : CONTENT_TYPE[effectiveFormat]

  const rawUpload = await supabase.storage
    .from('templates_raw')
    .upload(rawPath, rawBlob, {
      contentType: rawContentType,
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

  // 4-b. PDF / image テンプレ専用: 入力経路 A / B 分岐
  //   - パス A（未書込原本、デフォルト）: PDF を `_blank.pdf` にコピー → blank_pdf_status='ready'
  //   - パス B（書込済 → 白塗り化）: `_blank.pdf` は未生成、blank_pdf_status='pending_whiteout'
  //   image 由来テンプレは常にパス B として扱う（白紙化不要、変換 PDF を直接使う）。
  let backgroundPdfPath: string | null = null
  let inputPathType: 'A' | 'B' | null = null
  let licenseConsent: { user_id: string; agreed_at: string } | null = null
  if (effectiveFormat === 'pdf') {
    inputPathType = format === 'image' ? 'B' : (requestedPath ?? 'A')
    licenseConsent = { user_id: user.id, agreed_at: new Date().toISOString() }

    // PDF 専用パイプラインで bbox 付き実フィールドを抽出する。
    // 失敗時は汎用 schema.fields にフォールバックして upload 自体は通す。
    try {
      const analyzeBytes = new Uint8Array(effectiveFileBuf.byteLength)
      analyzeBytes.set(effectiveFileBuf)
      const analyzed = await analyzePdfFull({
        pdfBytes: analyzeBytes,
        inputPathType,
      })
      if (analyzed.fields.length > 0) {
        fieldsForDb = analyzed.fields
      }
    } catch (e) {
      console.error(
        '[upload] analyzePdfFull failed, fallback to generic schema.fields:',
        e instanceof Error ? e.message : String(e),
      )
    }

    if (inputPathType === 'A') {
      backgroundPdfPath = `${familyId}/${templateId}_blank.pdf`
      const blankUpload = await supabase.storage
        .from('templates_processed')
        .upload(backgroundPdfPath, new Blob([new Uint8Array(effectiveFileBuf)]), {
          contentType: CONTENT_TYPE.pdf,
          upsert: false,
        })
      if (blankUpload.error) throw blankUpload.error
    } else if (format === 'image') {
      // 画像由来: 変換済み PDF を blank として保存（白塗り不要）
      backgroundPdfPath = `${familyId}/${templateId}_blank.pdf`
      const blankUpload = await supabase.storage
        .from('templates_processed')
        .upload(backgroundPdfPath, new Blob([new Uint8Array(effectiveFileBuf)]), {
          contentType: CONTENT_TYPE.pdf,
          upsert: false,
        })
      if (blankUpload.error) throw blankUpload.error
    }
    // 通常パス B: backgroundPdfPath は null のまま。後段の /whiteout-apply で書き戻す
  }

  // 5. DB INSERT
  const { data, error } = await supabase
    .from('templates')
    .insert({
      id: templateId,
      family_id: familyId,
      name,
      source_format: effectiveFormat,
      source_path: rawPath,
      processed_path: processedPath,
      fields: fieldsForDb,
      is_default: false,
      created_by: user.id,
      background_pdf_path: backgroundPdfPath,
      input_path_type: inputPathType,
      license_consent: licenseConsent,
      origin_format: originFormat,
    })
    .select()
    .single()
  if (error) {
    const limit = mapDbErrorToResourceLimit(error)
    if (limit?.body.resource === 'templates') {
      throw new ResourceLimitError('templates')
    }
    throw error
  }

  // 6. blank PDF ステータス更新 + サムネ生成
  if (effectiveFormat === 'pdf') {
    let blankStatus: string
    if (format === 'image') {
      // 画像由来: blank PDF 生成済
      blankStatus = 'ready'
    } else {
      blankStatus = inputPathType === 'B' ? 'pending_whiteout' : 'ready'
    }
    await supabase
      .from('templates')
      .update({ blank_pdf_status: blankStatus })
      .eq('id', templateId)

    // パス A または画像由来は blank PDF が確定済なので即サムネ生成。
    if (inputPathType === 'A' || format === 'image') {
      const thumbBytes = new Uint8Array(effectiveFileBuf.byteLength)
      thumbBytes.set(effectiveFileBuf)
      await generateTemplateThumbnail(supabase, {
        familyId,
        templateId,
        pdfBytes: thumbBytes,
      })
    }
  } else {
    // docx 経路: CloudConvert API 呼出（失敗時は擬人化エラーで client に伝播）
    try {
      const blankPdfBuffer = await convertDocxToBlankPdf(effectiveFileBuf, `${name}.docx`)
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

/**
 * Guest-only template preview: parse + extract fields + rasterize thumbnail.
 * No DB INSERT or Storage upload is performed — returns fields and thumbnail as a base64 data URL.
 * Authenticated users should use uploadTemplate instead.
 *
 * Gate order: burst → Turnstile → guestTemplateLimit.
 * (burst check here because Server Actions bypass middleware)
 */
export async function previewTemplateAsGuest(input: {
  format: 'docx' | 'pdf' | 'image'
  fileBase64: string
  imageMime?: 'image/jpeg' | 'image/png' | 'image/webp'
  turnstileToken?: string
}): Promise<{ fields: { name: string; label: string }[]; thumbnailDataUrl: string | null }> {
  // Authenticated users must use the normal upload flow.
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (user) throw new Error('USE_UPLOAD_TEMPLATE')

  const h = await headers()
  const ip = getClientIpFromHeaders(h)

  // GR3: lightweight burst check (Server Actions bypass middleware).
  const burst = await ipBurstLimit.limit(`ip:${ip}`)
  if (!burst.success) throw new Error('TOO_MANY_REQUESTS')

  // Turnstile verification (skipped when TURNSTILE_SECRET_KEY is not set).
  const turnstile = await verifyTurnstile(input.turnstileToken ?? '', ip)
  if (!turnstile.ok) throw new Error('TURNSTILE_FAILED')

  // Per-IP cumulative limit for template previews (default: 2 per 90 days).
  const limit = await guestTemplateLimit.limit(`ip:${ip}`)
  if (!limit.success) throw new Error('TEMPLATE_LIMIT_GUEST')

  // File size check.
  const fileBuf = Buffer.from(input.fileBase64, 'base64')
  if (fileBuf.byteLength === 0) throw new Error('EMPTY_FILE')
  if (fileBuf.byteLength > MAX_FILE_BYTES) throw new Error('FILE_TOO_LARGE')

  const { format, imageMime } = input

  let pdfBuf: Buffer | null = null

  if (format === 'image') {
    if (!imageMime) throw new Error('IMAGE_MIME_REQUIRED')
    const imageBytes = new Uint8Array(fileBuf.byteLength)
    imageBytes.set(fileBuf)
    const converted = await imageToA4Pdf(imageBytes, imageMime)
    pdfBuf = Buffer.from(converted)
  } else if (format === 'pdf') {
    pdfBuf = fileBuf
  }

  const effectiveFormat = format === 'image' ? 'pdf' : format
  const parser = getParser(effectiveFormat)
  const parseBuf = pdfBuf ?? fileBuf
  const intermediate = await parser.parse(
    parseBuf.buffer.slice(parseBuf.byteOffset, parseBuf.byteOffset + parseBuf.byteLength) as ArrayBuffer,
  )

  let fields: { name: string; label: string }[]

  if (effectiveFormat === 'pdf' && pdfBuf) {
    // PDF/image path: use analyzePdfFull for bbox-aware field extraction; fall back to generic.
    try {
      const analyzeBytes = new Uint8Array(pdfBuf.byteLength)
      analyzeBytes.set(pdfBuf)
      const analyzed = await analyzePdfFull({ pdfBytes: analyzeBytes, inputPathType: 'A' })
      if (analyzed.fields.length > 0) {
        fields = analyzed.fields.map((f) => ({
          name: f.name,
          label: f.label ?? f.name,
        }))
      } else {
        const schema = await extractTemplateStructure(intermediate)
        fields = schema.fields.map((f) => ({ name: f.name, label: f.label ?? f.name }))
      }
    } catch {
      const schema = await extractTemplateStructure(intermediate)
      fields = schema.fields.map((f) => ({ name: f.name, label: f.label ?? f.name }))
    }
  } else {
    // docx path: generic structure extraction only (no CloudConvert, no thumbnail).
    const schema = await extractTemplateStructure(intermediate)
    fields = schema.fields.map((f) => ({ name: f.name, label: f.label ?? f.name }))
  }

  // Thumbnail generation: PDF/image only, in-memory, returned as base64 data URL.
  // docx returns null (CloudConvert is not called for guests).
  let thumbnailDataUrl: string | null = null
  if (effectiveFormat === 'pdf' && pdfBuf) {
    try {
      const pdfBytes = new Uint8Array(pdfBuf.byteLength)
      pdfBytes.set(pdfBuf)
      const totalPages = await getPdfNumPages(pdfBytes)
      const result = await renderPdfToImages({
        pdfBytes,
        totalPages,
        pageRange: { from: 1, to: 1 },
        requestedDpi: 72,
        format: 'png',
        asZip: false,
        forceDpi: true,
      })
      const b64 = Buffer.from(result.bytes).toString('base64')
      thumbnailDataUrl = `data:${result.contentType};base64,${b64}`
    } catch {
      // Thumbnail failure is non-fatal; fields preview is still returned.
      thumbnailDataUrl = null
    }
  }

  return { fields, thumbnailDataUrl }
}
