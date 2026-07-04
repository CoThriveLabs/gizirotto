import { notFound } from 'next/navigation'
import { getTemplate } from '@/server/templates'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { isBuiltinTemplate } from '@/lib/templates/builtin-ids'
import DeleteButton from '@/app/(dashboard)/templates/[id]/delete-button'
import BboxEditorClient from '@/app/(dashboard)/templates/[id]/bbox-editor-client'

export const dynamic = 'force-dynamic'

/**
 * テンプレ詳細ページ（公開フロー版）。
 *
 * - builtin テンプレ ID のみアクセス可。それ以外は 404（user テンプレへの直 URL 攻撃を防ぐ）。
 * - 未ログイン時は BboxEditorClient を readOnly モードで表示し、編集・保存 UI を無効化する。
 * - ログイン済みかつ自家族テンプレへの直 URL は 404（builtin のみ通過）。
 */
export default async function TemplateDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  // builtin 以外の ID で直接アクセスした場合は 404。
  // 未ログイン時に user テンプレの ID が URL に入れられても弾く。
  if (!isBuiltinTemplate(id)) {
    notFound()
  }

  let template: Awaited<ReturnType<typeof getTemplate>>
  try {
    template = await getTemplate(id)
  } catch {
    notFound()
  }

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const isAuthenticated = !!user

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-serif text-gizirotto-blue-900">
              {template.name}
            </h1>
            {template.is_default && (
              <span className="text-xs bg-gizirotto-blue-100 text-gizirotto-blue-700 px-2 py-0.5 rounded">
                サンプル
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-1">
            登録日: {new Date(template.created_at).toLocaleDateString('ja-JP')}
          </p>
        </div>
        {/* builtin テンプレは削除ボタンを出さない（is_default=true のため不変）。
            ログイン済みでも DeleteButton は builtin には不要。 */}
        {isAuthenticated && !template.is_default && (
          <DeleteButton templateId={template.id} templateName={template.name} />
        )}
      </header>

      <section className="space-y-3">
        <h2 className="text-lg text-gizirotto-blue-900">記入欄の位置を確認</h2>
        {!isAuthenticated && (
          <p className="text-sm text-gray-500">
            編集・保存にはログインが必要です。
          </p>
        )}
        <BboxEditorClient
          templateId={template.id}
          backHref="/templates"
          readOnly={!isAuthenticated}
        />
      </section>
    </div>
  )
}
