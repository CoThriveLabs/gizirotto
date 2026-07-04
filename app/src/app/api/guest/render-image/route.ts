import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { isBuiltinTemplate } from '@/lib/templates/builtin-ids'
import {
  resolveBuiltinBboxSlugFromTemplateId,
  loadBuiltinBackgroundPng,
} from '@/lib/builtin-bbox-loader'
import { generateBlankA4Png } from '@/lib/pdf-output/blank-a4-png'
import { errorResponse } from '@/lib/api/error-response'

export const runtime = 'nodejs'
export const maxDuration = 30

const FALLBACK_DPI = 150
const MAX_CONTENT_KEYS = 30
const MAX_OVERRIDE_KEYS = 30

// Mirrors the partial bbox/fontSize override shape used by the authenticated
// AdjustView save path (server/minutes.ts fieldOverrideSchema). Duplicated here
// because that module has a 'use server' directive and cannot export plain consts.
// Gotcha: if server/minutes.ts's fieldOverrideSchema changes shape, this copy must be
// updated in lockstep — there is no shared import path across the 'use server' boundary.
const fieldOverrideSchema = z
  .object({
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    w: z.number().finite().positive().optional(),
    h: z.number().finite().positive().optional(),
    fontSize: z.number().finite().positive().optional(),
  })
  .strict()

// content/overrides accept the same shape as the authenticated route, with explicit
// key-count caps added: this endpoint has no auth/session gate to fall back on, so
// payload size must be bounded on its own.
const requestSchema = z.object({
  templateId: z.string().uuid(),
  content: z
    .record(z.string().min(1).max(100), z.string().max(8000))
    .refine((v) => Object.keys(v).length <= MAX_CONTENT_KEYS, {
      message: 'TOO_MANY_CONTENT_KEYS',
    }),
  overrides: z
    .record(z.string().min(1).max(100), fieldOverrideSchema)
    .refine((v) => Object.keys(v).length <= MAX_OVERRIDE_KEYS, {
      message: 'TOO_MANY_OVERRIDE_KEYS',
    }),
  raw: z.boolean().optional(),
  raw_except_selected: z.string().min(1).max(100).optional(),
})

/**
 * POST /api/guest/render-image
 *
 * Unauthenticated background-image endpoint for the guest AdjustView preview.
 * Builtin templates only — isBuiltinTemplate is re-checked here independent of the
 * page-level gate, since this route has no session/DB lookup to fall back on for
 * authorization.
 *
 * Always returns the static builtin background PNG (or a blank-A4 fallback) for the
 * resolved template. It never reads a minute row, never queries the templates table,
 * and never writes to the image_cache bucket — slug resolution is a pure ID lookup
 * (resolveBuiltinBboxSlugFromTemplateId) and the PNG itself is read straight from
 * public/builtin-templates/. content/overrides are validated for payload-shape parity
 * with the authenticated render-image route but are not composited server-side here;
 * dynamic field values are layered on the client via canvas, same as the existing
 * AdjustView "raw" preview contract.
 */
export async function POST(request: NextRequest) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return errorResponse('INVALID_JSON', 400)
  }

  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) {
    return errorResponse('INVALID_REQUEST', 400, parsed.error)
  }

  // Defense in depth: guests can only ever reach builtin template IDs via the
  // page-level gate, but this route is reachable directly, so it re-checks here too.
  if (!isBuiltinTemplate(parsed.data.templateId)) {
    return errorResponse('TEMPLATE_NOT_ALLOWED', 403)
  }

  const slug = resolveBuiltinBboxSlugFromTemplateId(parsed.data.templateId)
  const pngBytes = slug ? await loadBuiltinBackgroundPng(slug) : null

  if (pngBytes) {
    return new NextResponse(Buffer.from(pngBytes) as unknown as BodyInit, {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    })
  }

  // Slug resolution or asset read failed — fall back to a blank A4 page rather than a
  // 500, matching the authenticated route's existing fallback policy.
  try {
    const blank = await generateBlankA4Png(FALLBACK_DPI)
    return new NextResponse(Buffer.from(blank.bytes) as unknown as BodyInit, {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    })
  } catch (err) {
    return errorResponse('IMAGE_RENDER_FAILED', 500, err)
  }
}
