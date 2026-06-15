/**
 * 既存テンプレのサムネ救済バックフィル（G1-④、設計書 §1-4 案 A・ワンショット）。
 *
 * upload 時自動生成は新規テンプレにしか効かないため、既に
 * thumbnail_status IN ('pending','failed') のまま放置されている PDF テンプレを
 * 列挙し、generateTemplateThumbnail ヘルパーで順次生成する。
 *
 * 冪等: upsert で image_cache に保存するため再実行可。生成成功で 'ready' に遷移するので
 * 2 回目以降は対象から外れる（'ready' は列挙対象外）。
 *
 * 使い方:
 *   pnpm tsx scripts/backfill-template-thumbnails.ts
 *
 * 必須環境変数（app/.env.local）:
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - SUPABASE_SECRET_KEY（service role）
 *
 * 対象条件:
 *   - source_format = 'pdf'（docx は skipped 方針のため対象外）
 *   - thumbnail_status IN ('pending','failed')
 *   - background_pdf_path あり（blank PDF 未確定のパス B 未適用テンプレは対象外）
 *   - family_id あり（builtin は image_cache RLS の都合で生成不可）
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import { generateTemplateThumbnail } from '../src/lib/pdf-output/template-thumbnail'

dotenv.config({
  path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local'),
})

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY が必要です')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
})

type TemplateRow = {
  id: string
  family_id: string | null
  name: string
  source_format: string
  background_pdf_path: string | null
  thumbnail_status: string | null
}

async function main() {
  console.log('[backfill-template-thumbnails] starting...')

  const { data, error } = await supabase
    .from('templates')
    .select(
      'id, family_id, name, source_format, background_pdf_path, thumbnail_status',
    )
    .eq('source_format', 'pdf')
    .in('thumbnail_status', ['pending', 'failed'])
  if (error) {
    console.error('failed to fetch templates:', error)
    process.exit(1)
  }

  const rows = (data ?? []) as TemplateRow[]
  const targets = rows.filter((t) => t.background_pdf_path && t.family_id)
  const skipped = rows.length - targets.length
  console.log(
    `found ${rows.length} pending/failed pdf templates, ${targets.length} processable (${skipped} skipped: no blank_pdf or builtin)`,
  )

  let okCount = 0
  let failCount = 0

  for (const tpl of targets) {
    const label = `${tpl.name} (${tpl.id})`
    try {
      const { data: pdfBlob, error: dlErr } = await supabase.storage
        .from('templates_processed')
        .download(tpl.background_pdf_path as string)
      if (dlErr || !pdfBlob) {
        console.error(`[${label}] blank PDF download failed:`, dlErr)
        failCount++
        continue
      }
      const pdfBytes = new Uint8Array(await pdfBlob.arrayBuffer())
      const result = await generateTemplateThumbnail(supabase, {
        familyId: tpl.family_id,
        templateId: tpl.id,
        pdfBytes,
      })
      if (result.ok) {
        console.log(`[${label}] ready → ${result.thumbnailPath}`)
        okCount++
      } else {
        console.error(`[${label}] generate failed: ${result.code}`)
        failCount++
      }
    } catch (e) {
      console.error(
        `[${label}] unexpected error:`,
        e instanceof Error ? e.message : String(e),
      )
      failCount++
    }
  }

  console.log(
    `[backfill-template-thumbnails] done. ok=${okCount} fail=${failCount} skipped=${skipped}`,
  )
}

main().catch((e) => {
  console.error('[backfill-template-thumbnails] fatal:', e)
  process.exit(1)
})
