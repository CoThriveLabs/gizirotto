import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { getTemplate } from '@/server/templates'
import { isBuiltinTemplate } from '@/lib/templates/builtin-ids'

export const dynamic = 'force-dynamic'

interface SearchParams {
  template_id?: string
  intent?: 'ai' | 'manual'
}

/**
 * 議事録新規作成入口（モード分岐）。
 *  - template_id 必須（テンプレ選択画面から遷移してくる）
 *  - builtin テンプレ ID のみ通過（user テンプレへの直 URL は 404）
 *  - intent=manual → B-2 直行 (/minutes/new/manual)
 *  - intent=ai (default) → モード選択（A-1 / A-2 / B-2 ボタン提示）
 *  - 未ログインでも表示可（DB 書き込み操作は各モード画面で分岐）
 */
export default async function MinutesNewPage({
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

  const template = await getTemplate(templateId)
  const intent = params.intent === 'manual' ? 'manual' : 'ai'

  if (intent === 'manual') {
    redirect(`/minutes/new/manual?template_id=${templateId}`)
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-6">
      <header>
        <h1 className="text-xl font-serif text-gizirotto-blue-900">
          作り方を選ぶ
        </h1>
        <p className="text-xs text-gray-500 mt-1">
          テンプレ: {template.name}
        </p>
      </header>

      <ul className="space-y-3">
        <li>
          <Link
            href={`/minutes/new/chat?mode=A-1&template_id=${templateId}`}
            className="block bg-white border border-gizirotto-blue-200 rounded p-4 hover:border-gizirotto-blue-400"
          >
            <h2 className="text-sm font-medium text-gizirotto-blue-900">
              質問に答えていく
            </h2>
            <p className="text-xs text-gray-600 mt-1">
              AI が項目を一つずつ質問します。順番に答えていけば議事録が完成します。
            </p>
          </Link>
        </li>
        <li>
          <Link
            href={`/minutes/new/chat?mode=A-2&template_id=${templateId}`}
            className="block bg-white border border-gizirotto-blue-200 rounded p-4 hover:border-gizirotto-blue-400"
          >
            <h2 className="text-sm font-medium text-gizirotto-blue-900">
              会話しながら考える
            </h2>
            <p className="text-xs text-gray-600 mt-1">
              AI と自由に会話しながら、まとまったら議事録にします。
            </p>
          </Link>
        </li>
        <li>
          <Link
            href={`/minutes/new/manual?template_id=${templateId}`}
            className="block bg-white border border-gizirotto-blue-200 rounded p-4 hover:border-gizirotto-blue-400"
          >
            <h2 className="text-sm font-medium text-gizirotto-blue-900">
              テンプレに直接書く
            </h2>
            <p className="text-xs text-gray-600 mt-1">
              テンプレートを開いて、その場で項目・配置・見た目まで自分で整えます。
            </p>
          </Link>
        </li>
      </ul>

      <p className="text-xs text-gray-400 text-center pt-4">
        ※ AI による生成結果は完璧ではありません
      </p>
    </div>
  )
}
