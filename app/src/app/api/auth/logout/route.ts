/**
 * /api/auth/logout — ログアウト処理。
 *
 * クライアントから POST で受け、Supabase server-side で signOut してから
 * cookie 削除をレスポンスに同梱する。/api/auth/login と同じ Cookie 反映パターン。
 * GET は許容しない（CSRF 緩和: 副作用ある操作は POST のみ）。
 */

import { NextResponse } from 'next/server'
import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { cookies } from 'next/headers'

type CookieToSet = { name: string; value: string; options: CookieOptions }

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST() {
  const cookieStore = await cookies()
  const response = NextResponse.json({ ok: true })
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cs: CookieToSet[]) =>
          cs.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          ),
      },
    },
  )

  // signOut() は session が無くてもエラーを返さない（Supabase 仕様）。
  // 念のため try-catch で握り潰し、cookie 削除を最優先する。
  try {
    await supabase.auth.signOut()
  } catch {
    // session 既無し / network エラーでも cookie 反映は続行
  }

  return response
}
