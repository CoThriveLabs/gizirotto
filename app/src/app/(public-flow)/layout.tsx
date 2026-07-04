import Link from 'next/link'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { ToastProvider } from '@/components/toast/toast-context'
import { Header } from '@/components/Header'
import { HomeIcon } from '@/components/icons/HomeIcon'
import { SubNav } from '@/app/(home)/_components/SubNav'

/**
 * 未ログインでも閲覧可能なルート群の共通レイアウト。
 * - 未認証でも redirect しない（page 側で個別チェック）
 * - ログイン済みの場合は Header にユーザー情報を渡す
 * - family データは取得しない（未ログイン許容 + RLS 制約のため）
 */
export default async function PublicFlowLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  let displayName = ''
  let familyName = ''

  if (user) {
    // ログイン済みの場合のみ family データ取得を試みる。
    // 取得できなくても render を続行（redirect しない）。
    try {
      const { data: memberRow } = await supabase
        .from('family_members')
        .select('display_name, family_id')
        .eq('user_id', user.id)
        .maybeSingle()

      if (memberRow?.family_id) {
        const { data: family } = await supabase
          .from('families')
          .select('name')
          .eq('id', memberRow.family_id)
          .maybeSingle()
        familyName = family?.name ?? ''
        displayName = memberRow.display_name ?? ''
      }
    } catch {
      // family 情報取得失敗は無視してレンダリング継続
    }
  }

  return (
    <ToastProvider>
      <div className="min-h-screen flex flex-col pb-16 md:pb-0">
        <Header familyName={familyName} displayName={displayName} />
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
