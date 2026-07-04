'use server'

import { z } from 'zod'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { getParser } from '@/lib/parsers'
import { extractTemplateStructure } from '@/lib/ai/structure-extractor'
import { generatePlaceholderDocx } from '@/lib/ai/template-processor'
import { decodeAccessTokenClaims } from '@/lib/jwt-claims'
import { convertDocxToBlankPdf } from '@/lib/cloudconvert'
import { analyzePdfFull } from '@/lib/parsers/pdf/analyze-pipeline'
import { imageToA4Pdf } from '@/lib/parsers/image/image-to-pdf'
import { generateTemplateThumbnail } from '@/lib/pdf-output/template-thumbnail'
import { mapDbErrorToResourceLimit, ResourceLimitError } from '@/lib/db-error-mapper'
import { MAX_FILE_BYTES, CONTENT_TYPE, PROCESSED_CONTENT_TYPE, type TemplateFieldForDb } from './shared'

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
