/**
 * POST /api/templates/[id]/render-image
 * 設計書 v1.4.8 §6-7 / §6-7-b（render-image API テンプレ原本 PDF 経路）。
 *
 * テンプレ原本 PDF（パス A: 未書込原本 / パス B: `_blank.pdf` 白塗り済）
 * → 画像（PNG / 複数ページ ZIP）に変換し image_cache に保存。
 *
 * 認証ガード 3 層は議事録 route と同一（§3-10-e）。
 */
import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import {
  renderPdfToImages,
  renderRawPdfWithWhiteoutToImages,
  getPdfNumPages,
} from '@/lib/pdf-output/image-renderer'
import { clampDpi } from '@/lib/pdf-output/dpi-downgrade'
import type { WhiteoutBox } from '@/lib/parsers/pdf/whiteout-pipeline'
import { errorResponse } from '@/lib/api/error-response'

export const runtime = 'nodejs'
export const maxDuration = 30

interface RenderImageRequestBody {
  dpi?: number
  format?: 'png' | 'jpeg'
  pageRange?: { from: number; to: number }
  asZip?: boolean
  forceDpi?: boolean
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: templateId } = await params
  if (!templateId) {
    return NextResponse.json({ error: 'MISSING_TEMPLATE_ID' }, { status: 400 })
  }

  const supabase = await createSupabaseServerClient()

  // ガード ①: JWT 認証
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 })
  }

  // ガード ②: templates RLS（family_id 不一致は 0 件 → 404 隠蔽）
  const { data: template, error: tplErr } = await supabase
    .from('templates')
    .select(
      'id, family_id, background_pdf_path, input_path_type, source_path, whiteout_boxes',
    )
    .eq('id', templateId)
    .maybeSingle()
  if (tplErr) {
    return NextResponse.json({ error: 'DB_ERROR' }, { status: 500 })
  }
  if (!template) {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  }
  if (!template.background_pdf_path) {
    return NextResponse.json(
      { error: 'PDF_SOURCE_NOT_AVAILABLE' },
      { status: 404 },
    )
  }
  const familyId = template.family_id as string
  const pdfStoragePath = template.background_pdf_path as string

  // 白塗りテンプレは _blank.pdf を rasterize すると A500 を踏むため、
  // bbox-editor / サムネ救済と同型の C-2（raw 背景 + 白塗り PNG 再合成）で退治する。
  // whiteout_boxes が 1 件以上 & source_path あり → raw 再合成経路。それ以外は従来 _blank.pdf 経路（後方互換）。
  const whiteoutBoxes = Array.isArray(template.whiteout_boxes)
    ? (template.whiteout_boxes as unknown as WhiteoutBox[])
    : []
  const useRawWhiteoutPath =
    whiteoutBoxes.length > 0 && !!template.source_path

  // リクエスト解析
  const body = (await request.json().catch(() => ({}))) as RenderImageRequestBody
  const dpi = clampDpi(body.dpi, 150)
  const format: 'png' | 'jpeg' = body.format === 'jpeg' ? 'jpeg' : 'png'
  const asZip = body.asZip ?? false
  const forceDpi = body.forceDpi ?? false
  const pageRange = body.pageRange

  // image_cache hit 確認
  // jpeg はファイル拡張子として jpg を使う（一般慣行）
  const formatExt = format === 'jpeg' ? 'jpg' : 'png'
  const cacheExt = asZip ? 'zip' : formatExt
  const cacheKey = `${familyId}/templates/${templateId}_${dpi}_${format}.${cacheExt}`
  const { data: cached } = await supabase.storage
    .from('image_cache')
    .createSignedUrl(cacheKey, 3600)
  if (cached?.signedUrl) {
    return NextResponse.json(
      { cached: true, signedUrl: cached.signedUrl, cacheKey },
      { status: 200 },
    )
  }

  // レンダリング（経路分岐）
  let result: Awaited<ReturnType<typeof renderPdfToImages>>
  if (useRawWhiteoutPath) {
    // C-2 退治: 健全な raw PDF（templates_raw）を rasterize → 白塗り PNG 再合成。
    // _blank.pdf は rasterize しない（A500 を構造的に回避）。
    // 合成失敗時は renderRawPdfWithWhiteoutToImages が throw → 素の raw を出さず 500（個人情報死守）。
    const { data: rawBlob, error: rawDlErr } = await supabase.storage
      .from('templates_raw')
      .download(template.source_path as string)
    if (rawDlErr || !rawBlob) {
      return NextResponse.json({ error: 'PDF_DOWNLOAD_FAILED' }, { status: 500 })
    }
    const rawBytes = new Uint8Array(await rawBlob.arrayBuffer())
    try {
      result = await renderRawPdfWithWhiteoutToImages({
        rawPdfBytes: rawBytes,
        whiteoutBoxes,
        pageRange,
        requestedDpi: dpi,
        format,
        asZip,
      })
    } catch (err) {
      return errorResponse('IMAGE_RENDER_FAILED', 500, err)
    }
  } else {
    // 従来経路（白塗りなし / 旧データ）: _blank.pdf をそのまま rasterize（非破壊）。
    const { data: pdfBlob, error: dlErr } = await supabase.storage
      .from('templates_processed')
      .download(pdfStoragePath)
    if (dlErr || !pdfBlob) {
      return NextResponse.json({ error: 'PDF_DOWNLOAD_FAILED' }, { status: 500 })
    }
    const pdfBytes = new Uint8Array(await pdfBlob.arrayBuffer())

    let totalPages: number
    try {
      totalPages = await getPdfNumPages(pdfBytes)
    } catch {
      return NextResponse.json({ error: 'PDF_NUMPAGES_FAILED' }, { status: 500 })
    }

    try {
      result = await renderPdfToImages({
        pdfBytes,
        totalPages,
        pageRange,
        requestedDpi: dpi,
        format,
        asZip,
        forceDpi,
      })
    } catch (err) {
      return errorResponse('IMAGE_RENDER_FAILED', 500, err)
    }
  }

  // image_cache 保存
  await supabase.storage
    .from('image_cache')
    .upload(cacheKey, result.bytes as unknown as Blob, {
      contentType: result.contentType,
      upsert: true,
    })

  const { data: signed } = await supabase.storage
    .from('image_cache')
    .createSignedUrl(cacheKey, 3600)

  return NextResponse.json(
    {
      cached: false,
      signedUrl: signed?.signedUrl ?? null,
      cacheKey,
      contentType: result.contentType,
      ext: result.ext,
      renderedPages: result.renderedPages,
      dpi: result.dpiDecision.dpi,
      originalDpi: result.dpiDecision.originalDpi,
      downgraded: result.dpiDecision.downgraded,
      estimatedMs: result.dpiDecision.estimatedMs,
      warnings: result.warnings,
    },
    { status: 200 },
  )
}
