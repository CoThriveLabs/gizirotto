import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getTemplate } from '@/server/templates'
import { ChatView } from './ChatView'
import type { TemplateField } from './ChatView'
import { FamilyUsageBadge } from '@/components/usage/family-usage-badge'

export const dynamic = 'force-dynamic'

interface SearchParams {
  template_id?: string
  mode?: 'A-1' | 'A-2'
}

/**
 * A-1 / A-2 チャット画面（§27-2 + §27-3）。
 * server component で family / template / mode 検証 → client component に渡す。
 */
export default async function MinutesNewChatPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams
  const hdrs = await headers()
  const familyId = hdrs.get('x-family-id')
  if (!familyId) redirect('/family/setup')

  const templateId = params.template_id
  if (!templateId) redirect('/templates?from=cta&intent=ai')

  const mode = params.mode === 'A-2' ? 'A-2' : 'A-1'
  const template = await getTemplate(templateId)
  const fields = extractFields(template.fields)

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-4 flex flex-col min-h-[calc(100vh-8rem)]">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-serif text-gizirotto-blue-900">
            {mode === 'A-1' ? '質問に答えていく' : '会話しながら考える'}
          </h1>
          <p className="text-xs text-gray-500 mt-1">
            テンプレ: {template.name}
          </p>
        </div>
        {/* 残数バッジ */}
        <FamilyUsageBadge />
      </header>

      <ChatView
        templateId={templateId}
        templateName={template.name}
        mode={mode}
        fields={fields}
      />

      <p className="text-xs text-gray-400 text-center pt-2">
        ※ AI による生成結果は完璧ではありません
      </p>
    </div>
  )
}

function extractFields(raw: unknown): TemplateField[] {
  if (!raw) return []
  // templates.fields は新形式 `{ fields: [...] }` だが Phase 5a 以前のテンプレで配列直書き
  // `[...]` の個体があり両形式受ける（B-5 / B-6 救済、chat/stream route と同経路）。
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
      const label =
        typeof obj.label_ja === 'string'
          ? obj.label_ja
          : typeof obj.label === 'string'
            ? obj.label
            : name
      return { name, label }
    })
    .filter((v): v is TemplateField => v !== null)
}
