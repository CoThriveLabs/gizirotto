'use server'

import { headers } from 'next/headers'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { getParser } from '@/lib/parsers'
import { extractTemplateStructure } from '@/lib/ai/structure-extractor'
import { analyzePdfFull } from '@/lib/parsers/pdf/analyze-pipeline'
import { imageToA4Pdf } from '@/lib/parsers/image/image-to-pdf'
import { renderPdfToImages, getPdfNumPages } from '@/lib/pdf-output/image-render-worker'
import { ipBurstLimit, guestTemplateLimit } from '@/lib/ratelimit'
import { verifyTurnstile } from '@/lib/turnstile'
import { getClientIpFromHeaders } from '@/lib/client-ip'
import { MAX_FILE_BYTES } from './shared'

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
