import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import QRCode from 'qrcode'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { MemberAvatar } from '@/components/MemberAvatar'
import { CopyInviteCodeButton } from './_components/CopyInviteCodeButton'
import { RegenerateInviteCodeButton } from './_components/RegenerateInviteCodeButton'
import { UsageSection } from './_components/UsageSection'

export const metadata = {
  title: '家族メンバー',
  robots: { index: false, follow: false },
}

interface MemberRow {
  id: string
  user_id: string
  display_name: string
  role: string
  created_at: string
}

export default async function MembersPage() {
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
    .select('id, name, invite_code')
    .eq('id', familyId)
    .single()

  const { data: members } = await supabase
    .from('family_members')
    .select('id, user_id, display_name, role, created_at')
    .eq('family_id', familyId)
    .order('created_at', { ascending: true })

  const allMembers = (members ?? []) as MemberRow[]
  const me = allMembers.find((m) => m.user_id === user.id)
  const others = allMembers.filter((m) => m.user_id !== user.id)
  const isAdmin = me?.role === 'admin'

  let inviteUrl: string | null = null
  let inviteQrSvg: string | null = null
  if (isAdmin && family?.invite_code) {
    const protocol = hdrs.get('x-forwarded-proto') ?? 'http'
    const host = hdrs.get('host') ?? 'localhost:3000'
    inviteUrl = `${protocol}://${host}/family/join?code=${family.invite_code}`
    inviteQrSvg = await QRCode.toString(inviteUrl, {
      type: 'svg',
      margin: 1,
      width: 200,
    })
  }

  return (
    <main className="min-h-screen px-4 py-6">
      <div className="max-w-2xl mx-auto space-y-8">
        <header className="flex items-center justify-between">
          <h1 className="text-xl font-serif text-gizirotto-blue-900">家族メンバー</h1>
          <Link
            href="/"
            className="text-sm text-gizirotto-blue-700 hover:underline"
          >
            ← ホームに戻る
          </Link>
        </header>

        {me && (
          <section className="bg-white border border-gizirotto-blue-200 rounded-lg p-6 text-center space-y-3">
            <div className="flex justify-center">
              <MemberAvatar displayName={me.display_name} size="lg" />
            </div>
            <div className="space-y-1">
              <p className="text-base font-medium text-gray-900">
                {me.display_name}
              </p>
              <div className="flex items-center justify-center gap-2 text-xs">
                <span className="bg-gizirotto-blue-500 text-white px-2 py-0.5 rounded">
                  自分
                </span>
                <span className="bg-gray-100 text-gray-700 px-2 py-0.5 rounded">
                  {me.role === 'admin' ? '管理者' : 'メンバー'}
                </span>
              </div>
            </div>
          </section>
        )}

        <UsageSection />

        {others.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-gray-700">
              他のメンバー
            </h2>
            <ul className="space-y-2">
              {others.map((m) => (
                <li
                  key={m.id}
                  className="bg-white border border-gray-200 rounded-lg p-4 flex items-center gap-3"
                >
                  <MemberAvatar displayName={m.display_name} size="sm" />
                  <div className="flex-1">
                    <p className="text-sm text-gray-900">{m.display_name}</p>
                  </div>
                  <span className="text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded">
                    {m.role === 'admin' ? '管理者' : 'メンバー'}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {isAdmin && family?.invite_code && inviteUrl && inviteQrSvg && (
          <section className="bg-white border border-gizirotto-blue-200 rounded-lg p-6 space-y-4">
            <h2 className="text-sm font-medium text-gray-700">家族を増やす</h2>
            <div className="space-y-2">
              <p className="text-xs text-gray-500">招待コード</p>
              <div className="flex items-center gap-2 flex-wrap">
                <code className="flex-1 min-w-[12rem] bg-gray-50 border border-gray-200 rounded px-3 py-2 text-lg font-mono tracking-widest text-gray-900">
                  {family.invite_code}
                </code>
                <CopyInviteCodeButton
                  code={family.invite_code}
                  url={inviteUrl}
                />
                <RegenerateInviteCodeButton />
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-xs text-gray-500">招待 URL</p>
              <code className="block bg-gray-50 border border-gray-200 rounded px-3 py-2 text-xs text-gray-700 break-all">
                {inviteUrl}
              </code>
            </div>
            <div className="space-y-2">
              <p className="text-xs text-gray-500">QR コード</p>
              <div
                className="flex justify-center bg-white p-3 border border-gray-200 rounded"
                role="img"
                aria-label="招待 URL の QR コード"
                dangerouslySetInnerHTML={{ __html: inviteQrSvg }}
              />
            </div>
          </section>
        )}
      </div>
    </main>
  )
}
