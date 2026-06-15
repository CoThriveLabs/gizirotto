/**
 * N-5 修正検証: regenerateMinutePdf で fields[].bbox NULL テンプレでも
 * simple-pdf-generator fallback が走り output_pdf_path が更新されることを確認する。
 *
 * 使い方:
 *   pnpm tsx scripts/verify-n5-fix.ts <minute_id>
 *
 * 必須 env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import { regenerateMinutePdf } from '../src/lib/pdf-output/regenerate-minute-pdf'

dotenv.config({
  path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local'),
})

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY が必要です')
  process.exit(1)
}

const minuteId = process.argv[2] ?? 'f26bf29a-7415-4f06-b7f8-cd7dff503ca7'

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
})

async function main() {
  console.log(`[verify-n5] minute_id=${minuteId}`)

  // 事前状態
  const { data: before } = await supabase
    .from('minutes')
    .select('id, family_id, template_id, title, output_pdf_path')
    .eq('id', minuteId)
    .maybeSingle()
  console.log('[verify-n5] before:', before)
  if (!before) {
    console.error('minute not found')
    process.exit(1)
  }

  const { data: tpl } = await supabase
    .from('templates')
    .select('id, name, background_pdf_path, blank_pdf_status, fields')
    .eq('id', before.template_id)
    .maybeSingle()
  const fieldsRaw = Array.isArray(tpl?.fields)
    ? tpl?.fields
    : (tpl?.fields as { fields?: unknown } | null)?.fields
  const bboxStats = Array.isArray(fieldsRaw)
    ? {
        total: fieldsRaw.length,
        withBbox: fieldsRaw.filter(
          (f) =>
            !!f &&
            typeof f === 'object' &&
            !!(f as { bbox?: unknown }).bbox &&
            typeof ((f as { bbox?: { page?: unknown } }).bbox as { page?: unknown })?.page === 'number',
        ).length,
      }
    : { total: 0, withBbox: 0 }
  console.log('[verify-n5] template:', {
    name: tpl?.name,
    background_pdf_path: tpl?.background_pdf_path,
    blank_pdf_status: tpl?.blank_pdf_status,
    bboxStats,
  })

  // 実行
  const result = await regenerateMinutePdf(supabase, minuteId)
  console.log('[verify-n5] result:', result)
  if (!result.ok) {
    console.error('regenerate failed:', result.reason)
    process.exit(1)
  }

  // 事後状態
  const { data: after } = await supabase
    .from('minutes')
    .select('id, output_pdf_path, thumbnail_path, thumbnail_status')
    .eq('id', minuteId)
    .maybeSingle()
  console.log('[verify-n5] after:', after)

  // Storage 確認
  const { data: blob, error: dlErr } = await supabase.storage
    .from('minutes_output')
    .download(result.outputPath)
  if (dlErr || !blob) {
    console.error('output PDF download failed:', dlErr)
    process.exit(1)
  }
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const magic = String.fromCharCode(...bytes.slice(0, 4))
  console.log('[verify-n5] output pdf:', {
    path: result.outputPath,
    byteLength: bytes.byteLength,
    magic,
  })
  if (magic !== '%PDF') {
    console.error('output is not a PDF')
    process.exit(1)
  }
  console.log('[verify-n5] OK')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
