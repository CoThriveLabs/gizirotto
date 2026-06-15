/**
 * 構造抽出精度テスト用フィクスチャを生成するスクリプト。
 *
 * 設計書 §D-3 の暫定運用「自作フィクスチャ 10 件（家族会議 5 / 子の予定 3 / 家計報告 2）」に従う。
 * - 5 件は Word (.docx)、5 件は PDF 風テキスト（unpdf でも処理可能な簡易 PDF）
 * - PDF は別途手動で作成が望ましいが、本スクリプトは Word を全 10 件で代用するためのプロトタイプ
 *   （実際の知人サンプル受領後、PDF 5 件分は差し替え運用）
 *
 * 出力:
 *   tests/fixtures/templates/*.docx
 *   tests/fixtures/expected.json
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generatePlaceholderDocx } from '../src/lib/ai/template-processor'
import type { TemplateField, TemplateSchema } from '../src/lib/ai/schemas/template-schema'

type Fixture = { filename: string; title: string; schema: TemplateSchema }

const FIXTURES: Fixture[] = [
  // 家族会議 5 件
  {
    filename: 'family_meeting_01.docx',
    title: '家族会議',
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
    filename: 'family_meeting_02.docx',
    title: '田中家月例会議',
    schema: {
      title_position: 'top',
      fields: [
        { name: 'meeting_date', label: '日付', type: 'date', default: 'today', required: true },
        { name: 'attendees', label: '参加者', type: 'list', required: true },
        { name: 'agenda', label: '議題', type: 'list', required: true },
        { name: 'decisions', label: '決定事項', type: 'list', required: true },
      ],
    },
  },
  {
    filename: 'family_meeting_03.docx',
    title: '佐藤家ミーティング',
    schema: {
      title_position: 'top',
      fields: [
        { name: 'meeting_date', label: '日付', type: 'date', default: 'today', required: true },
        { name: 'attendees', label: '参加者', type: 'list', required: true },
        { name: 'agenda', label: '議題', type: 'list', required: true },
        { name: 'next_actions', label: '次回までのアクション', type: 'list', required: false },
      ],
    },
  },
  {
    filename: 'family_meeting_04.docx',
    title: 'ファミリー会議',
    schema: {
      title_position: 'top',
      fields: [
        { name: 'meeting_date', label: '日付', type: 'date', default: 'today', required: true },
        { name: 'attendees', label: '参加者', type: 'list', required: true },
        { name: 'topics', label: '話し合いトピック', type: 'list', required: true },
        { name: 'memo', label: 'メモ', type: 'text', required: false },
      ],
    },
  },
  {
    filename: 'family_meeting_05.docx',
    title: '週末家族会議',
    schema: {
      title_position: 'top',
      fields: [
        { name: 'meeting_date', label: '日付', type: 'date', default: 'today', required: true },
        { name: 'attendees', label: '参加者', type: 'list', required: true },
        { name: 'agenda', label: '議題', type: 'list', required: true },
        { name: 'decisions', label: '決定事項', type: 'list', required: true },
        { name: 'todos', label: '宿題', type: 'list', required: false },
      ],
    },
  },
  // 子の予定 3 件
  {
    filename: 'child_schedule_01.docx',
    title: '子の予定',
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
    filename: 'child_schedule_02.docx',
    title: '運動会の予定',
    schema: {
      title_position: 'top',
      fields: [
        { name: 'event_date', label: '日付', type: 'date', default: 'today', required: true },
        { name: 'place', label: '場所', type: 'text', required: true },
        { name: 'items', label: '持ち物', type: 'list', required: false },
        { name: 'escort', label: '送迎担当', type: 'text', required: false },
      ],
    },
  },
  {
    filename: 'child_schedule_03.docx',
    title: '習い事の予定',
    schema: {
      title_position: 'top',
      fields: [
        { name: 'event_date', label: '日付', type: 'date', default: 'today', required: true },
        { name: 'place', label: '場所', type: 'text', required: true },
        { name: 'items', label: '持ち物', type: 'list', required: false },
        { name: 'notes', label: '注意事項', type: 'list', required: false },
      ],
    },
  },
  // 家計報告 2 件
  {
    filename: 'budget_report_01.docx',
    title: '家計報告',
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
  {
    filename: 'budget_report_02.docx',
    title: '田中家家計報告',
    schema: {
      title_position: 'top',
      fields: [
        { name: 'month', label: '月度', type: 'text', required: true },
        { name: 'income', label: '収入', type: 'text', required: true },
        { name: 'expense', label: '支出', type: 'text', required: true },
        { name: 'savings', label: '貯蓄', type: 'text', required: false },
      ],
    },
  },
]

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'templates')
const EXPECTED_PATH = join(FIX_DIR, '..', 'expected.json')

async function main() {
  mkdirSync(FIX_DIR, { recursive: true })
  const expected: Record<string, { fields: TemplateField[] }> = {}
  for (const f of FIXTURES) {
    const buf = await generatePlaceholderDocx(f.schema, f.title)
    writeFileSync(join(FIX_DIR, f.filename), Buffer.from(buf))
    expected[f.filename] = { fields: f.schema.fields }
    console.log(`built fixture: ${f.filename}`)
  }
  writeFileSync(EXPECTED_PATH, JSON.stringify(expected, null, 2))
  console.log(`wrote expected.json (${FIXTURES.length} fixtures)`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
