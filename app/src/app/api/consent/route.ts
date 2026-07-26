/**
 * /api/consent — 同意モーダルで取得した同意を user_consents に記録する。
 *
 * - 認証済みユーザー（auth.uid()）でのみ INSERT 可能（RLS）。
 * - IP は x-forwarded-for ヘッダーから取得（best effort, nullable）。
 * - 両方の同意フラグが true でない場合は 400 を返す。
 * - 同一ユーザー・同一バージョンの記録が既にあれば INSERT せずに成功を返す（冪等）。
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

  // 重複記録の抑止。テーブル側に一意制約が無いため、同一ユーザー・同一バージョンの行が
  // 既にあれば INSERT せず成功として返す（モーダル再送信・多重タブでの積み上がり防止）。
  // SELECT 自体が失敗した場合は判定不能なので、記録漏れを避けて INSERT 側に進む。
  const { data: existing } = await supabase
    .from('user_consents')
    .select('id')
    .eq('user_id', user.id)
    .eq('terms_version', TERMS_VERSION)
    .eq('privacy_version', PRIVACY_VERSION)
    .limit(1)
    .maybeSingle()

  if (existing) {
    return NextResponse.json({ ok: true })
  }

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
