/**
 * 既存議事録のサムネ救済バックフィル。
 *
 * v1.1 位置づけ: 主救済経路は P3/P4 の **on-demand 自動 trigger**（議事録表示時に
 * useEffect が pending を検知して再生成 API を叩く）。本スクリプトは
 * **マイグレ緊急用・開発者向け任意救済手段** として残す。通常運用では走らせない。
 *
 * 残置理由:
 *   - (a) 大量議事録を一括で温める必要が出た場合の保険
 *   - (b) 自動 trigger が想定外に止まった際の手動救済
 *   - (c) マイグレ直後の事前ウォームアップ
 *
 * 冪等: generateMinuteThumbnail 内で remove→upload(upsert:false)。生成成功で
 * 'ready' 遷移 → 2 回目以降は対象から外れる。
 *
 * 使い方:
 *   pnpm tsx scripts/backfill-minute-thumbnails.ts
 *
 * 必須環境変数（app/.env.local）:
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - SUPABASE_SECRET_KEY（service role）
 *
 * 対象条件（§3.4.1・v1.2 改訂）:
 *   - thumbnail_path is null OR thumbnail_status IN ('pending','failed')
 *   - family_id あり（builtin は image_cache RLS の都合で生成不可）
 *   - v1.2: output_pdf_path 必須条件を撤去。raw 起点経路は output_pdf_path を
 *     参照せず、内部で templates_raw から source_path を引いて合成する。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import { generateMinuteThumbnail } from '../src/lib/pdf-output/minute-thumbnail'

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

type MinuteRow = {
  id: string
  family_id: string | null
  thumbnail_path: string | null
  thumbnail_status: string | null
}

async function main() {
  console.log('[backfill-minute-thumbnails] starting...')

  const { data, error } = await supabase
    .from('minutes')
    .select('id, family_id, thumbnail_path, thumbnail_status')
    .or('thumbnail_path.is.null,thumbnail_status.in.(pending,failed)')
  if (error) {
    console.error('failed to fetch minutes:', error)
    process.exit(1)
  }

  const rows = (data ?? []) as MinuteRow[]
  // v1.2: output_pdf_path 必須を撤去。family_id 必須のみ JS フィルタ。
  // source_path 欠落は generateMinuteThumbnail 内で RAW_PATH_NOT_AVAILABLE → failed 遷移。
  const targets = rows.filter((m) => m.family_id)
  const skipped = rows.length - targets.length
  console.log(
    `found ${rows.length} pending/failed/null minutes, ${targets.length} processable (${skipped} skipped: no family_id)`,
  )

  let okCount = 0
  let failCount = 0

  // テンプレ側 backfill 同様 sleep なし（順次直列・拡大解釈禁止）。
  for (const m of targets) {
    const label = `${m.id}`
    try {
      const result = await generateMinuteThumbnail(supabase, {
        minuteId: m.id,
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
    `[backfill-minute-thumbnails] done. ok=${okCount} fail=${failCount} skipped=${skipped}`,
  )
}

main().catch((e) => {
  console.error('[backfill-minute-thumbnails] fatal:', e)
  process.exit(1)
})
