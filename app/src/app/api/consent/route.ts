/**
 * /api/consent — 同意モーダルで取得した同意を user_consents に記録する。
 *
 * - 認証済みユーザー（auth.uid()）でのみ INSERT 可能（RLS）。
 * - IP は x-forwarded-for ヘッダーから取得（best effort, nullable）。
 * - 両方の同意フラグが true でない場合は 400 を返す。
 */

import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { TERMS_VERSION, PRIVACY_VERSION } from '@/lib/legal/versions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    termsAgreed?: boolean
    privacyAgreed?: boolean
  } | null

  if (!body || !body.termsAgreed || !body.privacyAgreed) {
    return NextResponse.json(
      { error: '利用規約・プライバシーポリシー双方への同意が必要です' },
      { status: 400 },
    )
  }

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null

  const { error } = await supabase.from('user_consents').insert({
    user_id: user.id,
    terms_version: TERMS_VERSION,
    privacy_version: PRIVACY_VERSION,
    ip_address: ip,
  })

  if (error) {
    return NextResponse.json(
      { error: '同意の記録に失敗しました' },
      { status: 500 },
    )
  }

  return NextResponse.json({ ok: true })
}
