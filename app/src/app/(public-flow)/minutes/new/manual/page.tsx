import { notFound, redirect } from 'next/navigation'
import { getTemplate } from '@/server/templates'
import { isBuiltinTemplate } from '@/lib/templates/builtin-ids'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { ManualBootstrap } from '@/app/(dashboard)/minutes/new/manual/ManualBootstrap'

export const dynamic = 'force-dynamic'

interface SearchParams {
  template_id?: string
}

/**
 * B-2 手動入力モード（公開フロー版）。
 * - builtin テンプレ ID のみ通過（user テンプレへの直 URL は 404）
 * - 未ログインでも表示可。ManualBootstrap に isGuest を渡して createMinute 未ログイン分岐を有効化。
 * - page.tsx は server component のまま。mutation 系 API は呼ばない（revalidatePath 制約のため）。
 */
export default async function MinutesNewManualPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams

  const templateId = params.template_id
  if (!templateId) redirect('/templates?from=cta&intent=manual')

  // builtin 以外の ID は 404。未ログイン時の user テンプレ偽装を弾く。
  if (!isBuiltinTemplate(templateId)) {
    notFound()
  }

  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  const template = await getTemplate(templateId)
  const fields = extractFieldNames(template.fields)

  return (
    <ManualBootstrap
      templateId={templateId}
      templateName={template.name}
      fields={fields}
      isGuest={!user}
    />
  )
}

/**
 * テンプレ.fields から name の配列を抽出する。
 * Phase 5a 旧テンプレ (ARRAY) と新形式 ({fields:[]}) 両対応（B-5/B-6 救済）。
 */
function extractFieldNames(raw: unknown): string[] {
  if (!raw) return []
  const fieldsArr: unknown = Array.isArray(raw)
    ? raw
    : typeof raw === 'object'
      ? (raw as { fields?: unknown }).fields
      : null
  if (!Array.isArray(fieldsArr)) return []
  const out: string[] = []
  for (const f of fieldsArr) {
    if (!f || typeof f !== 'object') continue
    const name = (f as Record<string, unknown>).name
    if (typeof name === 'string' && name.length > 0) out.push(name)
  }
  return out
}
