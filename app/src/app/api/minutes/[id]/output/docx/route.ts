import PizZip from 'pizzip'
import Docxtemplater from 'docxtemplater'
import { NextResponse, type NextRequest } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { flattenContent, sanitizeFilename } from '@/lib/utils/minutes-output'

export const runtime = 'nodejs'
export const maxDuration = 30

/**
 * POST /api/minutes/[id]/output/docx
 * 議事録の Word 出力。
 *
 * 1. minutes WHERE id=[id] + RLS 検証 → content + template_id 取得
 * 2. templates_processed/{template_id}_processed.docx fetch
 * 3. docxtemplater で content バインド → output Buffer
 * 4. minutes_output/{family_id}/{id}.docx に upload + minutes.output_docx_path UPDATE
 * 5. signed URL 生成 → JSON return { downloadUrl, expiresAt }
 *
 * cost: $0（既存 OSS docxtemplater）。出力時間目標: < 2 秒。
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

  // 1. minutes 取得（RLS で自家族のみ可視）
  const { data: minute, error: minuteErr } = await supabase
    .from('minutes')
    .select('id, family_id, template_id, title, meeting_date, content_json, output_docx_path')
    .eq('id', minuteId)
    .maybeSingle()
  if (minuteErr || !minute) {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  }
  if (!minute.template_id) {
    return NextResponse.json({ error: 'TEMPLATE_MISSING' }, { status: 400 })
  }

  // 2. テンプレ processed_path 取得
  const { data: tpl, error: tplErr } = await supabase
    .from('templates')
    .select('processed_path')
    .eq('id', minute.template_id)
    .maybeSingle()
  if (tplErr || !tpl?.processed_path) {
    return NextResponse.json({ error: 'TEMPLATE_NOT_FOUND' }, { status: 404 })
  }

  // 3. processed docx fetch
  const { data: file, error: dlErr } = await supabase.storage
    .from('templates_processed')
    .download(tpl.processed_path)
  if (dlErr || !file) {
    return NextResponse.json({ error: 'TEMPLATE_DOWNLOAD_FAILED' }, { status: 500 })
  }
  const arrayBuf = await file.arrayBuffer()

  // 4. docxtemplater で content バインド
  let outputBuf: Buffer
  try {
    const zip = new PizZip(arrayBuf)
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      delimiters: { start: '{', end: '}' },
      nullGetter: () => '',
    })
    const flatContent = flattenContent(minute.content_json, {
      title: minute.title,
      meeting_date: minute.meeting_date,
    })
    doc.render(flatContent)
    outputBuf = doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer
  } catch {
    return NextResponse.json({ error: 'RENDER_FAILED' }, { status: 500 })
  }

  // 5. storage upload (upsert で再生成対応) + DB UPDATE
  const outputPath = `${minute.family_id}/${minute.id}.docx`
  const blankPdfBlob = new Blob([new Uint8Array(outputBuf).slice().buffer], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })
  const { error: upErr } = await supabase.storage
    .from('minutes_output')
    .upload(outputPath, blankPdfBlob, {
      contentType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      upsert: true,
    })
  if (upErr) {
    return NextResponse.json({ error: 'UPLOAD_FAILED' }, { status: 500 })
  }

  await supabase
    .from('minutes')
    .update({ output_docx_path: outputPath })
    .eq('id', minute.id)

  // 6. signed URL 生成（TTL 1 時間）
  const { data: signed, error: signErr } = await supabase.storage
    .from('minutes_output')
    .createSignedUrl(outputPath, 3600, {
      download: `${sanitizeFilename(minute.title)}.docx`,
    })
  if (signErr || !signed?.signedUrl) {
    return NextResponse.json({ error: 'SIGN_FAILED' }, { status: 500 })
  }

  return NextResponse.json({
    downloadUrl: signed.signedUrl,
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
  })
}

