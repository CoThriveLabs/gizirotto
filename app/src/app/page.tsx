import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { Header } from '@/components/Header'
import {
  RecentMinutesSection,
  type RecentMinute,
} from './(home)/_components/RecentMinutesSection'
import { CTASection } from './(home)/_components/CTASection'
import { SubNav } from './(home)/_components/SubNav'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'ぎじろっと',
  description: '家族・少人数グループの議事録を AI が下書き・整形する家庭用アプリ',
  robots: { index: false, follow: false },
}

export default async function HomePage() {
  const hdrs = await headers()
  const familyId = hdrs.get('x-family-id')
  if (!familyId) redirect('/family/setup')

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: family } = await supabase
    .from('families')
    .select('name')
    .eq('id', familyId)
    .maybeSingle()

  const { data: meRow } = await supabase
    .from('family_members')
    .select('display_name')
    .eq('family_id', familyId)
    .eq('user_id', user.id)
    .maybeSingle()
  const myDisplayName = meRow?.display_name ?? ''

  const { data: recentMinutes } = await supabase
    .from('minutes')
    .select('id, title, meeting_date, thumbnail_path, thumbnail_status')
    .eq('family_id', familyId)
    .order('meeting_date', { ascending: false })
    .limit(5)

  const rows = recentMinutes ?? []
  const minutesWithThumbs: RecentMinute[] = await Promise.all(
    rows.map(async (m) => {
      let signedUrl: string | null = null
      if (m.thumbnail_status === 'ready' && m.thumbnail_path) {
        const { data } = await supabase.storage
          .from('image_cache')
          .createSignedUrl(m.thumbnail_path, 3600)
        signedUrl = data?.signedUrl ?? null
      }
      // thumbStatus を渡す（3 分岐 UI + on-demand 自動 trigger 用）。
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

  return (
    <div className="min-h-screen flex flex-col">
      <Header familyName={family?.name ?? ''} displayName={myDisplayName} />
      <main className="flex-1 flex flex-col justify-between max-w-7xl w-full mx-auto px-4 py-12 pb-32 md:pb-12">
        <RecentMinutesSection minutes={minutesWithThumbs} />
        <div className="flex flex-col gap-10">
          <CTASection />
          <SubNav />
        </div>
      </main>
    </div>
  )
}
