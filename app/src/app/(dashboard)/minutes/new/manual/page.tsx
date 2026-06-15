import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getTemplate } from '@/server/templates'
import { ManualBootstrap } from './ManualBootstrap'

export const dynamic = 'force-dynamic'

interface SearchParams {
  template_id?: string
}

/**
 * 旧 B-2 項目モード直行画面（ManualForm）を廃止し、テンプレ選択 → 本ルート到達時に
 *   ダミー値で createMinute → AdjustView 直行する lazy create 経路。
 *
 *   🔴 重要（差し戻し再発防止）:
 *     本 page.tsx は **server component のまま** だが、`createMinute` /
 *     `redirect('/minutes/{id}/adjust')` / `revalidatePath` 等の mutation 系 API は
 *     **一切呼ばない**。createMinute 内部の `revalidatePath('/minutes')` が
 *     Next.js render 中 mutation 制約に抵触し Runtime Error
 *     （"used revalidatePath /minutes during render which is unsupported"）になるため。
 *
 *   ここでは headers/familyId / template 取得 / fields 計算だけを行い、
 *   client component `<ManualBootstrap />` に props を渡す薄いラッパとして動作する。
 *   実際の lazy create は ManualBootstrap の `useEffect` から Server Action として実行される。
 *
 *   ブックマーク後方互換のためルートは残す。ChatView (A-1/A-2) は本変更で影響を受けない。
 */
export default async function MinutesNewManualPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams
  const hdrs = await headers()
  const familyId = hdrs.get('x-family-id')
  if (!familyId) redirect('/family/setup')

  const templateId = params.template_id
  if (!templateId) redirect('/templates?from=cta&intent=manual')

  const template = await getTemplate(templateId)
  const fields = extractFieldNames(template.fields)

  return (
    <ManualBootstrap
      templateId={templateId}
      templateName={template.name}
      fields={fields}
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
