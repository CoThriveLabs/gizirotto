/**
 * builtin デフォルトテンプレ 3 種を CloudConvert で blank PDF 化 → storage 保存 →
 * `templates.blank_pdf_status='ready'` UPDATE するバッチスクリプト（Phase 5b §1-6、案 A）。
 *
 * idempotent: 既に blank_pdf_status='ready' の行はスキップ、再実行可能。
 *
 * 使い方:
 *   pnpm tsx scripts/seed-builtin-blank-pdf.ts
 *
 * 必須環境変数:
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - SUPABASE_SECRET_KEY
 *   - CLOUDCONVERT_API_KEY
 *
 * 動作:
 *   1. templates から is_default=true かつ blank_pdf_status<>'ready' の行を取得
 *   2. 各 docx 起源テンプレに対して source_path から raw docx を fetch
 *   3. CloudConvert で blank PDF 化
 *   4. templates_processed/{family_id}/{template_id}_blank.pdf に保存（family_id IS NULL なら 'builtin/'）
 *   5. blank_pdf_status='ready' + background_pdf_path UPDATE
 *
 * 失敗時: blank_pdf_status='failed' UPDATE + console.error、他テンプレは続行。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import { convertDocxToBlankPdf } from '../src/lib/cloudconvert'

dotenv.config({
  path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local'),
})

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY
const CLOUDCONVERT_API_KEY = process.env.CLOUDCONVERT_API_KEY

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY が必要です')
  process.exit(1)
}
if (!CLOUDCONVERT_API_KEY) {
  console.error('CLOUDCONVERT_API_KEY が必要です（app/.env.local に追記）')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
})

type TemplateRow = {
  id: string
  family_id: string | null
  name: string
  source_format: 'pdf' | 'docx' | 'builtin'
  source_path: string | null
  processed_path: string | null
  blank_pdf_status: string
}

async function main() {
  console.log('[seed-builtin-blank-pdf] starting...')

  const { data, error } = await supabase
    .from('templates')
    .select(
      'id, family_id, name, source_format, source_path, processed_path, blank_pdf_status',
    )
    .eq('is_default', true)
  if (error) {
    console.error('failed to fetch templates:', error)
    process.exit(1)
  }
  if (!data || data.length === 0) {
    console.log('no builtin templates found, nothing to do')
    return
  }

  const targets = (data as TemplateRow[]).filter(
    (t) => t.blank_pdf_status !== 'ready',
  )
  console.log(
    `found ${data.length} builtin templates, ${targets.length} need processing`,
  )

  let okCount = 0
  let skipCount = 0
  let failCount = 0

  for (const tpl of targets) {
    const label = `${tpl.name} (${tpl.id})`

    if (tpl.source_format === 'pdf') {
      // pdf 起源は既に H-1 暫定で _blank.pdf 保存済の想定 → ready マークのみ
      const { error: updErr } = await supabase
        .from('templates')
        .update({ blank_pdf_status: 'ready' })
        .eq('id', tpl.id)
      if (updErr) {
        console.error(`[${label}] mark ready failed:`, updErr)
        failCount++
      } else {
        console.log(`[${label}] pdf 起源 → ready マーク済`)
        skipCount++
      }
      continue
    }

    // source 選択: builtin = templates_processed の processed_path から / docx = templates_raw の source_path から
    const sourceBucket =
      tpl.source_format === 'builtin' ? 'templates_processed' : 'templates_raw'
    const sourcePath =
      tpl.source_format === 'builtin' ? tpl.processed_path : tpl.source_path
    if (!sourcePath) {
      console.warn(`[${label}] ${sourceBucket} のソースパス空、スキップ`)
      skipCount++
      continue
    }

    try {
      const { data: file, error: dlErr } = await supabase.storage
        .from(sourceBucket)
        .download(sourcePath)
      if (dlErr || !file) throw dlErr ?? new Error('download_failed')

      const arrayBuf = await file.arrayBuffer()
      const docxBuf = Buffer.from(arrayBuf)
      console.log(
        `[${label}] downloaded ${docxBuf.byteLength} bytes from ${sourceBucket}, converting...`,
      )

      const pdfBuf = await convertDocxToBlankPdf(docxBuf, `${tpl.name}.docx`)

      const blankPath = tpl.family_id
        ? `${tpl.family_id}/${tpl.id}_blank.pdf`
        : `builtin/${tpl.id}_blank.pdf`
      const { error: upErr } = await supabase.storage
        .from('templates_processed')
        .upload(blankPath, new Blob([new Uint8Array(pdfBuf)]), {
          contentType: 'application/pdf',
          upsert: true,
        })
      if (upErr) throw upErr

      const { error: updErr } = await supabase
        .from('templates')
        .update({
          blank_pdf_status: 'ready',
          background_pdf_path: blankPath,
        })
        .eq('id', tpl.id)
      if (updErr) throw updErr

      console.log(`[${label}] OK → ${blankPath}`)
      okCount++
    } catch (e) {
      console.error(`[${label}] failed:`, e instanceof Error ? e.message : e)
      await supabase
        .from('templates')
        .update({ blank_pdf_status: 'failed' })
        .eq('id', tpl.id)
      failCount++
    }
  }

  console.log(
    `\n[seed-builtin-blank-pdf] done. ok=${okCount} skip=${skipCount} fail=${failCount}`,
  )
  if (failCount > 0) process.exit(1)
}

main().catch((e) => {
  console.error('fatal:', e)
  process.exit(1)
})
