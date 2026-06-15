import { headers } from 'next/headers'
import { redirect, notFound } from 'next/navigation'
import { getMinutes } from '@/server/minutes'
import { getTemplate } from '@/server/templates'
import { EditForm } from './EditForm'
import type { TemplateField } from './EditForm'

export const dynamic = 'force-dynamic'

/**
 * 既存議事録の編集画面（§26-3）。B-2 項目モード相当 UI。
 * content 変更時は updateMinute() 内で output_*_path を NULL リセット = 次回 viewer で再出力。
 */
export default async function MinutesEditPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const hdrs = await headers()
  const familyId = hdrs.get('x-family-id')
  if (!familyId) redirect('/family/setup')

  let minutes: Awaited<ReturnType<typeof getMinutes>>
  try {
    minutes = await getMinutes(id)
  } catch {
    notFound()
  }

  const template = minutes.template_id
    ? await getTemplate(minutes.template_id)
    : null
  const fields = extractFields(template?.fields)
  const initialContent = (minutes.content_json as Record<string, unknown> | null) ?? {}

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-6">
      <header>
        <h1 className="text-xl font-serif text-gizirotto-blue-900">議事録を編集</h1>
        <p className="text-xs text-gray-500 mt-1">
          {template?.name ?? '(テンプレ不明)'}
        </p>
      </header>

      <EditForm
        id={id}
        initialTitle={minutes.title}
        initialMeetingDate={minutes.meeting_date}
        initialContent={initialContent}
        fields={fields}
      />

      <p className="text-xs text-gray-400 text-center pt-4">
        ※ AI による生成結果は完璧ではありません
      </p>
    </div>
  )
}

function extractFields(raw: unknown): TemplateField[] {
  if (!raw) return []
  // Phase 5a 旧テンプレ (ARRAY) と新形式 ({fields:[]}) 両対応 (B-5/B-6 救済)
  const fieldsArr: unknown = Array.isArray(raw)
    ? raw
    : typeof raw === 'object'
      ? (raw as { fields?: unknown }).fields
      : null
  if (!Array.isArray(fieldsArr)) return []
  return fieldsArr
    .map((f) => {
      if (!f || typeof f !== 'object') return null
      const obj = f as Record<string, unknown>
      const name = typeof obj.name === 'string' ? obj.name : null
      if (!name) return null
      // label_ja → label → name の3段フォールバック（chat/adjust と同パターン）。
      // DB 実値は `label` キーに日本語が入る（`label_ja` は存在しない個体が多い）。
      const label =
        typeof obj.label_ja === 'string'
          ? obj.label_ja
          : typeof obj.label === 'string'
            ? obj.label
            : name
      return {
        name,
        label,
        multiline: obj.multiline === true,
      }
    })
    .filter((v): v is TemplateField => v !== null)
}
