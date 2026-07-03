import { createSupabaseServerClient } from '@/lib/supabase/server'
import { renderPdfToImages, getPdfNumPages } from '@/lib/pdf-output/image-render-worker'
import { errorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import type { TplRow, RenderSourceResult } from './render-source-types'

export interface FallbackRenderParams {
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>
  outputPdfPath: string | null
  template: TplRow | null
  pageRange: { from: number; to: number } | undefined
  dpi: number
  format: 'png' | 'jpeg'
  asZip: boolean
  forceDpi: boolean
}

// フォールバック経路（後方互換）。output_pdf_path → background_pdf_path → 404。
export async function resolveFallbackRender(
  params: FallbackRenderParams,
): Promise<RenderSourceResult> {
  const { supabase, outputPdfPath, template, pageRange, dpi, format, asZip, forceDpi } = params

  const pdfPath = outputPdfPath
  let pdfBucket: 'minutes_output' | 'templates_processed'
  let pdfStoragePath: string
  if (pdfPath) {
    pdfBucket = 'minutes_output'
    pdfStoragePath = pdfPath
  } else if (template?.background_pdf_path) {
    pdfBucket = 'templates_processed'
    pdfStoragePath = template.background_pdf_path
  } else {
    return {
      ok: false,
      response: NextResponse.json({ error: 'PDF_SOURCE_NOT_AVAILABLE' }, { status: 404 }),
    }
  }

  const { data: pdfBlob, error: dlErr } = await supabase.storage
    .from(pdfBucket)
    .download(pdfStoragePath)
  if (dlErr || !pdfBlob) {
    return { ok: false, response: NextResponse.json({ error: 'PDF_DOWNLOAD_FAILED' }, { status: 500 }) }
  }
  const pdfBytes = new Uint8Array(await pdfBlob.arrayBuffer())

  let totalPages: number
  try {
    totalPages = await getPdfNumPages(pdfBytes)
  } catch {
    return { ok: false, response: NextResponse.json({ error: 'PDF_NUMPAGES_FAILED' }, { status: 500 }) }
  }

  try {
    const result = await renderPdfToImages({
      pdfBytes,
      totalPages,
      pageRange,
      requestedDpi: dpi,
      format,
      asZip,
      forceDpi,
    })
    return { ok: true, result }
  } catch (err) {
    return { ok: false, response: errorResponse('IMAGE_RENDER_FAILED', 500, err) }
  }
}
