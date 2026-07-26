import { notFound, redirect } from 'next/navigation'
import { getTemplate } from '@/server/templates'
import { isBuiltinTemplate } from '@/lib/templates/builtin-ids'
import { ChatView } from '@/app/(dashboard)/minutes/new/chat/ChatView'
import type { TemplateField } from '@/app/(dashboard)/minutes/new/chat/ChatView'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { decodeAccessTokenClaims } from '@/lib/jwt-claims'

export const dynamic = 'force-dynamic'

interface SearchParams {
  template_id?: string
  mode?: 'A-1' | 'A-2'
}

/**
 * A-1 / A-2 チャット画面（公開フロー版）。
 * - builtin テンプレ ID のみ通過（user テンプレへの直 URL は 404）
 * - 未ログインでも表示可。AI 実行時の rate-limit チェックは API route で行う（S2 実装予定）。
 * - 保存操作でのみログイン誘導（ChatView 側の DB 書き込み境界で分岐）
 */
export default async function MinutesNewChatPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams

  const templateId = params.template_id
  if (!templateId) redirect('/templates?from=cta&intent=ai')

  // builtin 以外の ID は 404。未ログイン時の user テンプレ偽装を弾く。
  if (!isBuiltinTemplate(templateId)) {
    notFound()
  }

  const mode = params.mode === 'A-2' ? 'A-2' : 'A-1'
  const [template, supabase] = await Promise.all([
    getTemplate(templateId),
    createSupabaseServerClient(),
  ])
  const { data: { user } } = await supabase.auth.getUser()
  const isGuest = !user
  // family 判定は JWT claims から行う（x-family-id ヘッダーはこのパスでは注入されないため）。
  const { data: { session } } = await supabase.auth.getSession()
  const needsFamilySetup = !isGuest && !decodeAccessTokenClaims(session?.access_token)?.family_id
  const fields = extractFields(template.fields)

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-4 flex flex-col min-h-[calc(100vh-8rem)]">
      <header>
        <h1 className="text-xl font-serif text-gizirotto-blue-900">
          {mode === 'A-1' ? '質問に答えていく' : '会話しながら考える'}
        </h1>
        <p className="text-xs text-gray-500 mt-1">
          テンプレ: {template.name}
        </p>
      </header>

      <ChatView
        templateId={templateId}
        templateName={template.name}
        mode={mode}
        fields={fields}
        isGuest={isGuest}
        needsFamilySetup={needsFamilySetup}
      />

      <p className="text-xs text-gray-400 text-center pt-2">
        ※ AI による生成結果は完璧ではありません
      </p>
    </div>
  )
}

function extractFields(raw: unknown): TemplateField[] {
  if (!raw) return []
  // templates.fields は新形式 `{ fields: [...] }` だが、旧形式の配列直書き
  // `[...]` の個体があり両形式受ける（chat/stream route と同一ロジック）。
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
