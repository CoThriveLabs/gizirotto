import { headers } from 'next/headers'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { Header } from '@/components/Header'
import {
  RecentMinutesSection,
  type RecentMinute,
} from './(home)/_components/RecentMinutesSection'
import { CTASection } from './(home)/_components/CTASection'
import { SubNav } from './(home)/_components/SubNav'
import { FamilySetupNotice } from './(home)/_components/FamilySetupNotice'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'ぎじろっと',
  description: '家族・少人数グループの議事録を AI が下書き・整形する家庭用アプリ',
  robots: { index: false, follow: false },
}

// 未ログイン / 家族未設定でも到達するホーム画面。
// データは家族単位（RLS）なので未認証では空にフォールバックし、
// Header は isAuthenticated=false で「ログイン」リンクを表示する。
// CTA / SubNav の保護パスへのリンクは middleware が next 付きで /login へ誘導する。
export default async function HomePage() {
  const hdrs = await headers()
  const familyId = hdrs.get('x-family-id')

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  let familyName = ''
  let myDisplayName = ''
  let minutesWithThumbs: RecentMinute[] = []

  if (user && familyId) {
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
    myDisplayName = meRow?.display_name ?? ''

    const { data: recentMinutes } = await supabase
      .from('minutes')
      .select('id, title, meeting_date, thumbnail_path, thumbnail_status')
      .eq('family_id', familyId)
      .order('meeting_date', { ascending: false })
      .limit(5)

    const rows = recentMinutes ?? []
    minutesWithThumbs = await Promise.all(
      rows.map(async (m) => {
        let signedUrl: string | null = null
        if (m.thumbnail_status === 'ready' && m.thumbnail_path) {
          const { data } = await supabase.storage
            .from('image_cache')
            .createSignedUrl(m.thumbnail_path, 3600)
          signedUrl = data?.signedUrl ?? null
        }
        const rawStatus = (m.thumbnail_status as string | null) ?? 'pending'
        const thumbStatus: RecentMinute['thumbStatus'] =
          rawStatus === 'ready' ||
          rawStatus === 'pending' ||
          rawStatus === 'failed' ||
          rawStatus === 'skipped'
            ? rawStatus
            : 'pending'
        return {
          id: m.id as string,
          title: m.title as string,
          meeting_date: m.meeting_date as string,
          thumbSignedUrl: signedUrl,
          thumbStatus,
        }
      }),
    )
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Header familyName={familyName} displayName={myDisplayName} isAuthenticated={!!user} />
      <main className="flex-1 flex flex-col justify-between max-w-7xl w-full mx-auto px-4 py-12 pb-32 md:pb-12">
        <RecentMinutesSection minutes={minutesWithThumbs} />
        <div className="flex flex-col gap-10">
          {user && !familyId && <FamilySetupNotice />}
          <CTASection />
          <SubNav />
        </div>
      </main>
    </div>
  )
}
