/**
 * builtin（デフォルトテンプレ 3 種類）の processed docx を生成 →
 * `templates_processed/builtin/` バケットへ投入する。
 *
 * 使い方:
 *   pnpm seed-storage             # .env.local の SUPABASE_URL / SUPABASE_SECRET_KEY を使う
 *   pnpm seed-storage --remote    # 同上（フラグは表示の意味のみ）
 *
 * 必須環境変数:
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - SUPABASE_SECRET_KEY
 *
 * 設計書 §C-4 / §2-5 準拠（v1 では Claude を呼ばず、template-processor.ts でゼロから docx 構築）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import { generatePlaceholderDocx } from '../src/lib/ai/template-processor'
import type { TemplateSchema } from '../src/lib/ai/schemas/template-schema'

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local') })

type BuiltinDef = {
  filename: string
  templateName: string
  schema: TemplateSchema
}

const BUILTINS: BuiltinDef[] = [
  {
    filename: 'family_meeting_processed.docx',
    templateName: '家族会議',
    schema: {
      title_position: 'top',
      fields: [
        { name: 'meeting_date', label: '日付', type: 'date', default: 'today', required: true },
        { name: 'attendees', label: '参加者', type: 'list', required: true },
        { name: 'agenda', label: '議題', type: 'list', required: true },
        { name: 'decisions', label: '決定事項', type: 'list', required: true },
        { name: 'todos', label: 'TODO', type: 'list', required: false },
      ],
    },
  },
  {
    filename: 'child_schedule_processed.docx',
    templateName: '子の予定',
    schema: {
      title_position: 'top',
      fields: [
        { name: 'event_date', label: '日付', type: 'date', default: 'today', required: true },
        { name: 'place', label: '場所', type: 'text', required: true },
        { name: 'items', label: '持ち物', type: 'list', required: false },
        { name: 'escort', label: '送迎担当', type: 'text', required: false },
        { name: 'notes', label: '注意事項', type: 'list', required: false },
      ],
    },
  },
  {
    filename: 'budget_report_processed.docx',
    templateName: '家計報告',
    schema: {
      title_position: 'top',
      fields: [
        { name: 'month', label: '月度', type: 'text', required: true },
        { name: 'income', label: '収入', type: 'text', required: true },
        { name: 'expense', label: '支出', type: 'text', required: true },
        { name: 'savings', label: '貯蓄', type: 'text', required: false },
        { name: 'next_plan', label: '次月予定', type: 'list', required: false },
      ],
    },
  },
]

const SEED_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'seed', 'templates')

async function buildAll(): Promise<{ filename: string; bytes: Buffer }[]> {
  mkdirSync(SEED_DIR, { recursive: true })
  const results: { filename: string; bytes: Buffer }[] = []
  for (const def of BUILTINS) {
    const buf = await generatePlaceholderDocx(def.schema, def.templateName)
    const bytes = Buffer.from(buf)
    const outPath = join(SEED_DIR, def.filename)
    writeFileSync(outPath, bytes)
    console.log(`built: ${outPath} (${bytes.byteLength} bytes)`)
    results.push({ filename: def.filename, bytes })
  }
  return results
}

async function uploadAll(items: { filename: string; bytes: Buffer }[]) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY
  if (!url || !key) {
    console.warn(
      '\n[warn] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY 未設定。ローカル docx 生成のみで終了します。',
    )
    return
  }
  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  for (const item of items) {
    const path = `builtin/${item.filename}`
    const res = await supabase.storage
      .from('templates_processed')
      .upload(path, item.bytes, {
        contentType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        upsert: true,
      })
    if (res.error) {
      console.error(`upload failed: ${path}: ${res.error.message}`)
      process.exitCode = 1
    } else {
      console.log(`uploaded: templates_processed/${path}`)
    }
  }
}

async function main() {
  const items = await buildAll()
  await uploadAll(items)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
