import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { sanitizeNextParam } from '@/lib/safe-next'

type CookieToSet = { name: string; value: string; options: CookieOptions }

type OtpType = 'signup' | 'invite' | 'magiclink' | 'recovery' | 'email_change' | 'email'

const OTP_TYPES: readonly OtpType[] = [
  'signup',
  'invite',
  'magiclink',
  'recovery',
  'email_change',
  'email',
]

function isOtpType(value: string | null): value is OtpType {
  return value !== null && (OTP_TYPES as readonly string[]).includes(value)
}

/**
 * Supabase Auth のコールバック。2 系統を処理する:
 *  - magic link / PKCE: ?code=... → exchangeCodeForSession
 *  - recovery / email_change 等の OTP: ?token_hash=...&type=... → verifyOtp
 *
 * 重要: Vercel (Edge/Serverless) 環境では cookies().set() 経由だと
 * 別途返す NextResponse に Set-Cookie ヘッダが乗らない。
 * そのため response オブジェクトを先に作り、response.cookies.set() で直接書き込む。
 * (Supabase 公式 Quick Start パターン)
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const tokenHash = searchParams.get('token_hash')
  const type = searchParams.get('type')
  const nextSafe = sanitizeNextParam(searchParams.get('next'), origin) ?? '/'

  const cookieStore = await cookies()
  const response = NextResponse.redirect(`${origin}${nextSafe}`)

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet: CookieToSet[]) => {
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          )
        },
      },
    },
  )

  if (tokenHash && isOtpType(type)) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash })
    if (!error) {
      return response
    }
    console.error('[auth/callback] verifyOtp failed:', error.message)
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      return response
    }
    console.error('[auth/callback] exchangeCodeForSession failed:', error.message)
  } else {
    console.error('[auth/callback] no code or token_hash in callback URL')
  }

  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`)
}
