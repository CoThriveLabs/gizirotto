import { createSupabaseServerClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { PasswordSettingsForm } from './_components/PasswordSettingsForm'
import { LogoutButton } from './_components/LogoutButton'
import { DeleteAccountSection } from './_components/DeleteAccountSection'
import { StyleLearningSection } from './_components/StyleLearningSection'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: '設定',
  robots: { index: false, follow: false },
}

export default async function SettingsPage() {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-8">
      <header>
        <h1 className="text-xl font-serif text-gizirotto-blue-900">設定</h1>
        <p className="text-xs text-gray-500 mt-1">{user.email}</p>
      </header>

      <section className="bg-white border border-gizirotto-blue-100 rounded-lg p-6 space-y-4">
        <div>
          <h2 className="text-lg font-serif text-gizirotto-blue-900">パスワード</h2>
          <p className="text-xs text-gray-500 mt-1">
            パスワードを設定すると、次回からメール認証なしでログインできます。
          </p>
        </div>
        <PasswordSettingsForm />
      </section>

      <section className="bg-white border border-gizirotto-blue-100 rounded-lg p-6 space-y-4">
        <div>
          <h2 className="text-lg font-serif text-gizirotto-blue-900">議事録の書き方を覚える</h2>
          <p className="text-xs text-gray-500 mt-1">
            この家庭の過去の議事録から文体の傾向を学習し、下書き作成に反映します。
            外部AIの学習に使われることはありません。
          </p>
        </div>
        <StyleLearningSection />
      </section>

      <section className="bg-white border border-gizirotto-blue-100 rounded-lg p-6 space-y-4">
        <div>
          <h2 className="text-lg font-serif text-gizirotto-blue-900">ログアウト</h2>
          <p className="text-xs text-gray-500 mt-1">
            ログアウトすると、再びログインするまで議事録の閲覧・編集はできません。
          </p>
        </div>
        <LogoutButton />
      </section>

      <section
        id="delete-account"
        className="bg-white border border-red-200 rounded-lg p-6 space-y-4 scroll-mt-24"
      >
        <div>
          <h2 className="text-lg font-serif text-red-700">アカウントを完全に削除</h2>
          <p className="text-xs text-gray-600 mt-1">
            議事録・テンプレ・家族設定など全データが復旧できなくなります。慎重に操作してください。
          </p>
        </div>
        <DeleteAccountSection />
      </section>
    </div>
  )
}
