/**
 * /api/auth/login — login / signup を一本化して受ける。
 *
 * クライアント (login ページ) からの login / signup を一本化して受ける。
 * isSignup フラグで signup_attempts 記録の有無を出し分ける。
 * 両経路 (magic / password・signup / login) で必ず Turnstile siteverify する。
 *
 * config.matcher で /api/auth は middleware IP burst から除外されているため、
 * この route 内の Turnstile + signup_attempts が事実上の防御。
 */

import { NextResponse } from 'next/server'
import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { verifyTurnstile } from '@/lib/turnstile'
import { recordSignupAttempt } from '@/lib/signup-attempts'

type CookieToSet = { name: string; value: string; options: CookieOptions }

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Bad Request' }, { status: 400 })

  const { mode, email, password, turnstileToken, emailRedirectTo, isSignup } =
    body as {
      mode?: 'magic' | 'password'
      email?: string
      password?: string
      turnstileToken?: string
      emailRedirectTo?: string
      isSignup?: boolean
    }
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()

  // 1) Turnstile 検証 (案A の核心・両経路必須)
  const v = await verifyTurnstile(turnstileToken ?? '', ip)
  if (!v.ok) {
    return NextResponse.json(
      { error: '認証チャレンジに失敗しました。ページを再読み込みしてください' },
      { status: 403 },
    )
  }

  // 2) signup (初回 magic link) なら IP 記録 (abuse 検知の源泉)
  if (isSignup) {
    await recordSignupAttempt({
      ip,
      emailDomain: email?.split('@')[1] ?? null,
    })
  }

  // 3) Supabase 認証をサーバ側で実行 (Cookie はレスポンスに直書き)。
  //    §8.2 note: magic / password 両経路で同一 response を setAll に渡し、
  //    Cookie 書き換え先と返却 Response がずれないようにする。
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

  if (mode === 'magic') {
    const { error } = await supabase.auth.signInWithOtp({
      email: email ?? '',
      options: { emailRedirectTo },
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
    // setAll が response に PKCE verifier Cookie を書くため、新 response を
    // 作らず同梱済みの response を再利用して body だけ差し替える。
    return NextResponse.json(
      { ok: true, sent: true },
      { headers: response.headers },
    )
  } else {
    const { error } = await supabase.auth.signInWithPassword({
      email: email ?? '',
      password: password ?? '',
    })
    if (error) {
      return NextResponse.json(
        { error: error.message, code: 'INVALID_CREDENTIALS' },
        { status: 401 },
      )
    }
    return response // session Cookie 同梱
  }
}
