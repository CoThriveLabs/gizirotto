import { headers } from 'next/headers'
import Link from 'next/link'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { ToastProvider } from '@/components/toast/toast-context'
import { Header } from '@/components/Header'
import { HomeIcon } from '@/components/icons/HomeIcon'
import { SubNav } from '@/app/(home)/_components/SubNav'

/**
 * ダッシュボード共通レイアウト。
 * - 未ログインなら /login へリダイレクト
 * - 全ダッシュボードページで共通ヘッダー表示
 *   familyId は middleware が JWT claims から x-family-id ヘッダーに注入。
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const hdrs = await headers()
  const familyId = hdrs.get('x-family-id')

  let familyName = ''
  let displayName = ''
  if (familyId) {
    const { data: family } = await supabase
      .from('families')
      .select('name')
      .eq('id', familyId)
      .maybeSingle()
    familyName = family?.name ?? ''

    const { data: meRow } = await supabase
      .from('family_members')
      .select('display_name')
      .eq('family_id', familyId)
      .eq('user_id', user.id)
      .maybeSingle()
    displayName = meRow?.display_name ?? ''
  }

  return (
    <ToastProvider>
      <div className="min-h-screen flex flex-col pb-16 md:pb-0">
        {/* このレイアウトは未ログインなら既に redirect 済みなので isAuthenticated は常に true。 */}
        <Header familyName={familyName} displayName={displayName} isAuthenticated={true} />
        {/* main content と同じ container 幅で🏠 ホームリンクを配置し左端を揃える。
            モバイルは下部 SubNav にホームボタン常駐のため非表示。 */}
        <div className="max-w-4xl mx-auto px-4 pt-3 w-full">
          <Link
            href="/"
            aria-label="ホームへ戻る"
            className="hidden sm:inline-flex items-center gap-1 text-sm text-gizirotto-blue-700 hover:text-gizirotto-blue-800 hover:underline"
          >
            <HomeIcon size={18} />
            <span>ホーム</span>
          </Link>
        </div>
        <main className="flex-1">{children}</main>
        <footer className="border-t border-gizirotto-blue-100 bg-white">
          <div className="max-w-4xl mx-auto px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
            <span>ご家族専用のデータです。AI の学習には使われません。</span>
            <Link href="/legal/terms" className="hover:underline">
              利用規約
            </Link>
            <Link href="/legal/privacy" className="hover:underline">
              プライバシーポリシー
            </Link>
          </div>
        </footer>
        <SubNav showPcNav={false} />
      </div>
    </ToastProvider>
  )
}
