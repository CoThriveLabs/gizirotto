/**
 * POST /api/templates/pdf/whiteout-apply
 * 設計書 v1.4.2 §6-3 / §3-6（パス B 白塗り確定 API）。
 *
 * 入力:
 *   - templateId: テンプレ ID
 *   - boxes: WhiteoutBox[]（UI で確定されたユーザー指定矩形）
 *
 * 処理:
 *   1. templates_raw から raw PDF 取得
 *   2. applyWhiteout で pdf-lib drawRectangle 適用
 *   3. templates_processed/{familyId}/{templateId}_blank.pdf に保存（upsert）
 *   4. templates.background_pdf_path / blank_pdf_status='ready' に更新
 *
 * Runtime: Node.js（pdf-lib 依存、§6-6）
 */
import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import {
  checkAiUsage,
  aiLimitExceededBody,
  logAiUsage,
} from '@/lib/ai-usage-guard'
import type { Json } from '@/lib/supabase/database.types'
import {
  applyWhiteout,
  type WhiteoutBox,
} from '@/lib/parsers/pdf/whiteout-pipeline'
import { generateTemplateThumbnail } from '@/lib/pdf-output/template-thumbnail'
import { errorResponse } from '@/lib/api/error-response'

export const runtime = 'nodejs'
export const maxDuration = 30

interface RequestBody {
  templateId?: string
  boxes?: WhiteoutBox[]
}

const PDF_CONTENT_TYPE = 'application/pdf'

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as RequestBody
  const templateId = body.templateId
  const boxes = Array.isArray(body.boxes) ? body.boxes : []
  if (!templateId) {
    return NextResponse.json({ error: 'MISSING_TEMPLATE_ID' }, { status: 400 })
  }

  const supabase = await createSupabaseServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 })
  }

  const { data: template, error: tplErr } = await supabase
    .from('templates')
    .select('id, family_id, source_path, source_format')
    .eq('id', templateId)
    .maybeSingle()
  if (tplErr) {
    return NextResponse.json({ error: 'DB_ERROR' }, { status: 500 })
  }
  if (!template) {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  }
  if (template.source_format !== 'pdf' || !template.source_path) {
    return NextResponse.json(
      { error: 'NOT_A_PDF_TEMPLATE' },
      { status: 400 },
    )
  }

  const familyId = template.family_id as string

  // 3 階層 atomic check
  // template の RLS 通過後・重い pdf-lib 処理の前に check する。
  const usageCheck = await checkAiUsage({ familyId, userId: user.id })
  if (usageCheck.exceeded) {
    return NextResponse.json(aiLimitExceededBody(usageCheck), { status: 429 })
  }

  // raw PDF 取得
  const { data: pdfBlob, error: dlErr } = await supabase.storage
    .from('templates_raw')
    .download(template.source_path as string)
  if (dlErr || !pdfBlob) {
    return NextResponse.json({ error: 'PDF_DOWNLOAD_FAILED' }, { status: 500 })
  }
  const rawPdfBytes = new Uint8Array(await pdfBlob.arrayBuffer())

  // 白塗り適用
  let blankPdfBytes: Uint8Array
  try {
    blankPdfBytes = await applyWhiteout(rawPdfBytes, boxes)
  } catch (err) {
    return errorResponse('WHITEOUT_APPLY_FAILED', 500, err)
  }

  // _blank.pdf に upsert（再塗り直しに対応）
  const blankPath = `${familyId}/${templateId}_blank.pdf`
  const upload = await supabase.storage
    .from('templates_processed')
    .upload(blankPath, new Blob([new Uint8Array(blankPdfBytes)]), {
      contentType: PDF_CONTENT_TYPE,
      upsert: true,
    })
  if (upload.error) {
    // Supabase StorageError は plain object（非 Error）のため、helper の `err instanceof Error`
    // 判定で本番マスクされる。非本番でも detail を出すため Error ラップして渡し、本番では
    // errorResponse 内で自動的に detail が落ちる。
    return errorResponse(
      'STORAGE_UPLOAD_FAILED',
      500,
      new Error(upload.error.message),
    )
  }

  // templates 更新
  // 焼き込み（background_pdf_path）は従来通り出力用に温存しつつ、白塗り座標 boxes を
  // whiteout_boxes に永続化する。これを raw 背景への再合成（A500 回避）と段階2のリッチ
  // 再編集の原本にする。boxes は JSON 化可能な WhiteoutBox[]。
  const { error: updErr } = await supabase
    .from('templates')
    .update({
      background_pdf_path: blankPath,
      blank_pdf_status: 'ready',
      whiteout_boxes: boxes as unknown as Json,
    })
    .eq('id', templateId)
  if (updErr) {
    // PostgrestError も plain object のため Error ラップして渡す。
    return errorResponse('DB_UPDATE_FAILED', 500, new Error(updErr.message))
  }

  // サムネは A500 を踏む焼き込み blank PDF ではなく、健全な raw PDF をラスタライズして
  // 白塗り座標を再合成して生成する。失敗してもサムネ status='failed' を記録するのみで
  // 白塗り確定自体は成功扱い。
  await generateTemplateThumbnail(supabase, {
    familyId,
    templateId,
    pdfBytes: rawPdfBytes,
    whiteoutBoxes: boxes,
  })

  // ai_usage_log INSERT (best-effort)
  // whiteout-apply はローカル PDF 処理のみで AI 呼出無し → cost=0、回数カウントのみ。
  void logAiUsage({
    familyId,
    userId: user.id,
    endpoint: 'whiteout-apply',
    costUsdEstimate: 0,
  })

  return NextResponse.json(
    {
      background_pdf_path: blankPath,
      boxesApplied: boxes.length,
    },
    { status: 200 },
  )
}
