import { NextResponse, type NextRequest } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { generateOverlayPdf } from '@/lib/pdf-output/overlay-generator'
import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'
import { flattenContent, sanitizeFilename } from '@/lib/utils/minutes-output'
import { errorResponse } from '@/lib/api/error-response'

export const runtime = 'nodejs'
export const maxDuration = 30

/**
 * POST /api/minutes/[id]/output/pdf
 * 議事録の PDF レイアウト保持出力。
 *
 * 1. minutes WHERE id=[id] + RLS 検証 → content + template_id + bbox_overrides 取得
 * 2. templates.blank_pdf_status 確認
 *    - 'ready' → background_pdf_path から blank PDF fetch
 *    - 'failed' → JSON で fallback 提示（client 側で D-14 3 択 modal trigger）
 *    - 'pending' → 「生成中」response（client 側で retry 案内）
 * 3. bbox_overrides を fields の bbox に適用（effective bbox = override.x ?? field.bbox.x）
 * 4. generateOverlayPdf() で pdf-lib drawText + NotoSansJP embed
 * 5. minutes_output/{family_id}/{id}.pdf upload + minutes.output_pdf_path UPDATE
 * 6. signed URL TTL 1 時間 + download filename
 *
 * Phase 5b 外部 API 非依存（D-7 PDF 経路統一）= docx 起源も Phase 2.5 拡張で blank PDF 化済前提。
 * 出力時 CloudConvert 障害でも PDF 出力可能。
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: minuteId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(minuteId)) {
    return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 })
  }

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 })
  }

  // 1. minutes 取得（RLS 自家族のみ）
  const { data: minute, error: minuteErr } = await supabase
    .from('minutes')
    .select('id, family_id, template_id, title, content_json, bbox_overrides, output_pdf_path')
    .eq('id', minuteId)
    .maybeSingle()
  if (minuteErr || !minute) {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  }
  if (!minute.template_id) {
    return NextResponse.json({ error: 'TEMPLATE_MISSING' }, { status: 400 })
  }

  // 2. テンプレ取得 + blank_pdf_status 確認
  const { data: tpl, error: tplErr } = await supabase
    .from('templates')
    .select('background_pdf_path, blank_pdf_status, fields')
    .eq('id', minute.template_id)
    .maybeSingle()
  if (tplErr || !tpl) {
    return NextResponse.json({ error: 'TEMPLATE_NOT_FOUND' }, { status: 404 })
  }

  // D-14 fallback トリガ用に明示的 status 応答
  if (tpl.blank_pdf_status === 'failed') {
    return NextResponse.json(
      {
        error: 'BLANK_PDF_FAILED',
        message:
          'このテンプレの背景 PDF を作れませんでした。再アップロードするか、別の出力方法を選んでください。',
        fallback: true,
      },
      { status: 409 },
    )
  }
  if (tpl.blank_pdf_status === 'pending') {
    return NextResponse.json(
      {
        error: 'BLANK_PDF_PENDING',
        message: 'テンプレの準備が終わっていません。少し時間を置いて再度お試しください。',
      },
      { status: 409 },
    )
  }
  if (!tpl.background_pdf_path) {
    return NextResponse.json({ error: 'BLANK_PDF_PATH_MISSING' }, { status: 409 })
  }

  // 3. blank.pdf fetch
  const { data: blankFile, error: dlErr } = await supabase.storage
    .from('templates_processed')
    .download(tpl.background_pdf_path)
  if (dlErr || !blankFile) {
    return NextResponse.json({ error: 'BLANK_PDF_DOWNLOAD_FAILED' }, { status: 500 })
  }
  const blankBytes = new Uint8Array(await blankFile.arrayBuffer())

  // 4. fields + bbox_overrides 適用
  const fields = normalizeFields(tpl.fields)
  if (fields.length === 0) {
    return NextResponse.json(
      {
        error: 'TEMPLATE_HAS_NO_FIELDS',
        message: 'テンプレに項目情報が見つかりませんでした。テンプレを再アップロードしてください。',
        fallback: true,
      },
      { status: 409 },
    )
  }
  const effectiveFields = applyBboxOverrides(fields, minute.bbox_overrides)
  const fieldValues = flattenContent(minute.content_json)

  // 5. overlay 生成
  let pdfBytes: Uint8Array
  let warnings: unknown[]
  try {
    const result = await generateOverlayPdf({
      blankPdfBytes: blankBytes,
      fields: effectiveFields,
      fieldValues,
    })
    pdfBytes = result.pdfBytes
    warnings = result.warnings
  } catch (err) {
    return errorResponse('OVERLAY_GENERATION_FAILED', 500, err, {
      message: 'PDF の作成に失敗しました。少し時間を置いて再度お試しください。',
    })
  }

  // 6. storage upload + signed URL
  const outputPath = `${minute.family_id}/${minute.id}.pdf`
  const blob = new Blob([pdfBytes.slice().buffer], { type: 'application/pdf' })
  const { error: upErr } = await supabase.storage
    .from('minutes_output')
    .upload(outputPath, blob, {
      contentType: 'application/pdf',
      upsert: true,
    })
  if (upErr) {
    return NextResponse.json({ error: 'UPLOAD_FAILED' }, { status: 500 })
  }
  await supabase
    .from('minutes')
    .update({ output_pdf_path: outputPath })
    .eq('id', minute.id)

  const { data: signed, error: signErr } = await supabase.storage
    .from('minutes_output')
    .createSignedUrl(outputPath, 3600, {
      download: `${sanitizeFilename(minute.title)}.pdf`,
    })
  if (signErr || !signed?.signedUrl) {
    return NextResponse.json({ error: 'SIGN_FAILED' }, { status: 500 })
  }

  return NextResponse.json({
    downloadUrl: signed.signedUrl,
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    warnings,
  })
}

function normalizeFields(raw: unknown): PdfField[] {
  if (!raw) return []
  // Phase 5a 旧テンプレ (ARRAY) と新形式 ({fields:[]}) 両対応 (B-5/B-6 救済)
  const arr: unknown = Array.isArray(raw)
    ? raw
    : typeof raw === 'object'
      ? (raw as { fields?: unknown }).fields
      : null
  if (!Array.isArray(arr)) return []
  return arr.filter(
    (f): f is PdfField =>
      !!f &&
      typeof f === 'object' &&
      typeof (f as { name?: unknown }).name === 'string' &&
      typeof (f as { bbox?: unknown }).bbox === 'object',
  ) as PdfField[]
}

function applyBboxOverrides(
  fields: PdfField[],
  overrides: unknown,
): PdfField[] {
  if (!overrides || typeof overrides !== 'object') return fields
  const ov = overrides as Record<string, { x?: unknown; y?: unknown }>
  return fields.map((f) => {
    const o = ov[f.name]
    if (!o || typeof o.x !== 'number' || typeof o.y !== 'number') return f
    return { ...f, bbox: { ...f.bbox, x: o.x, y: o.y } }
  })
}

