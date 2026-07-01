import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { decodeAccessTokenClaims } from '@/lib/jwt-claims'
import { ipBurstLimit } from '@/lib/ratelimit'
import { getClientIp } from '@/lib/client-ip'
import { resolveAllowedOrigin } from '@/lib/cors'

type CookieToSet = { name: string; value: string; options: CookieOptions }

// ホーム `/` は未ログインでも表示する（PF / 集客のため即ログイン画面を出さない）。
// DB 干渉操作（テンプレ・議事録・設定など）の入り口リンクは保護パスのまま残り、
// 未認証アクセス時に next 付きで /login へリダイレクト → ログイン成功後に
// 元の URL に復帰する（既存 login/page.tsx の sanitizeNextParam 経路）。
const PUBLIC_PATHS = [
  '/login',
  '/forgot-password',
  '/reset-password',
  '/auth/callback',
  '/legal',
  '/_next',
  '/favicon.ico',
  '/templates',         // builtin のみ閲覧可（page 側で builtin チェック）
  '/minutes/new',       // builtin のみ編集可（page 側で builtin チェック）
]
// `/` は早期 return しない: auth.getUser() + family_id JWT デコードを通して
// x-family-id ヘッダーを注入する必要があるため。未認証時は後続の
// `if (!user)` 分岐で個別通過させる。
const FAMILY_SETUP_PATH = '/family/setup'
const STATIC_FILE_EXT = /\.(svg|png|jpg|jpeg|gif|webp|ico|css|js|map|woff2?|otf|html)$/

function isJsonClient(req: NextRequest): boolean {
  const accept = req.headers.get('accept') ?? ''
  return accept.includes('application/json') || req.nextUrl.pathname.startsWith('/api/')
}

function unauthorizedOrRedirect(
  req: NextRequest,
  redirectTo: URL,
  errorCode: string,
  baseResponse: NextResponse,
): NextResponse {
  if (isJsonClient(req)) {
    return NextResponse.json({ error: errorCode }, { status: 401 })
  }
  const redirect = NextResponse.redirect(redirectTo)
  baseResponse.cookies.getAll().forEach((c) => {
    redirect.cookies.set(c.name, c.value)
  })
  return redirect
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // CORS preflight: auth フロー前に 204 で短絡。
  // Gotcha: unauthenticated OPTIONS being redirected breaks preflight (results in 400).
  if (request.method === 'OPTIONS') {
    const origin = request.headers.get('origin')
    const allowed = resolveAllowedOrigin(origin)
    const reqHeaders = request.headers.get('access-control-request-headers') ?? '*'
    const headers: Record<string, string> = {
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': reqHeaders,
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin, Access-Control-Request-Headers',
    }
    if (allowed) {
      headers['Access-Control-Allow-Origin'] = allowed
    }
    return new NextResponse(null, { status: 204, headers })
  }

  // IP burst limit applies to all /api/* routes, including guest-reachable ones.
  // env 未設定環境では ipBurstLimit が noop なので既存挙動を壊さない。
  // 注: config.matcher で api/auth・api/webhook は除外済 → ここには到達しない。
  if (pathname.startsWith('/api/')) {
    const ip = getClientIp(request)
    const { success, reset } = await ipBurstLimit.limit(`ip:${ip}`)
    if (!success) {
      return new NextResponse('Too many requests', {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil((reset - Date.now()) / 1000)),
        },
      })
    }
  }

  // Guest-reachable API endpoints (exact match only). These run their own
  // guest gate (Turnstile + rate-limit) internally, so middleware lets them
  // through without the auth redirect.
  // Gotcha: pathname === strict equality only — startsWith would open sub-paths.
  const GUEST_API_PATHS = [
    '/api/minutes/chat/stream',
    '/api/minutes/format-item',
    '/api/minutes/chat/extract-fields',
  ]
  if (GUEST_API_PATHS.some((p) => pathname === p)) {
    return NextResponse.next({ request })
  }

  // Guest-reachable builtin-asset API: gated internally (isBuiltinTemplate + zod), reads
  // no minute/session data, so the whole /api/guest/ prefix is opened here instead of an
  // exact-match list per route.
  // Gotcha: do not add session-aware or write-capable routes under /api/guest/ — anything
  // placed under this prefix bypasses the auth redirect entirely.
  if (pathname.startsWith('/api/guest/')) {
    return NextResponse.next({ request })
  }

  if (
    PUBLIC_PATHS.some((p) => pathname.startsWith(p)) ||
    STATIC_FILE_EXT.test(pathname)
  ) {
    return NextResponse.next({ request })
  }

  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet: CookieToSet[]) => {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          )
        },
      },
    },
  )

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    if (
      pathname === '/family/join' &&
      request.nextUrl.searchParams.get('code')
    ) {
      const inviteTarget = `${pathname}?${request.nextUrl.searchParams.toString()}`
      const loginUrl = new URL('/login', request.url)
      loginUrl.searchParams.set('next', inviteTarget)
      return unauthorizedOrRedirect(request, loginUrl, 'UNAUTHENTICATED', response)
    }

    // `/` は未認証でも通過させ、ホームを「ログインお願いします」表示で見せる。
    if (pathname === '/' || pathname === FAMILY_SETUP_PATH || pathname.startsWith('/family/')) {
      return response
    }

    // next 付きで /login に飛ばす → ログイン成功後に元の URL へ復帰。
    // sanitizeNextParam（既存）が同オリジン制限で検証する。
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('next', pathname + request.nextUrl.search)
    return unauthorizedOrRedirect(request, loginUrl, 'UNAUTHENTICATED', response)
  }

  // family_id は JWT claims (custom_access_token_hook 注入) から取得。
  // 注意: getUser() 戻り値の user.app_metadata は auth.users.raw_app_meta_data 列の中身で、
  // hook が JWT claims に追加した family_id とは別管理（Supabase 仕様）。
  // user identity は getUser() で署名検証済のため、session.access_token を decode して
  // claims を読むのは安全（cookie 信頼ベース脆弱性は user 検証で吸収済）。
  const { data: { session } } = await supabase.auth.getSession()
  const claims = decodeAccessTokenClaims(session?.access_token)
  const familyIdFromJwt = claims?.family_id

  if (!familyIdFromJwt) {
    // ホーム `/` は family 未設定でも表示する（CTA で setup へ誘導）。
    if (pathname === '/' || pathname.startsWith('/family/')) {
      return response
    }
    // builtin テンプレ閲覧・議事録新規作成フローは family 未設定でも通過させる。
    // page 側で isBuiltinTemplate チェックを行い、user テンプレへの直 URL は 404 にする。
    if (pathname === '/templates' || pathname.startsWith('/templates/')) {
      return response
    }
    if (pathname === '/minutes/new' || pathname.startsWith('/minutes/new/')) {
      return response
    }
    return unauthorizedOrRedirect(
      request,
      new URL(FAMILY_SETUP_PATH, request.url),
      'NOT_IN_FAMILY',
      response,
    )
  }

  if (pathname === FAMILY_SETUP_PATH) {
    return NextResponse.redirect(new URL('/', request.url))
  }

  response.headers.set('x-family-id', familyIdFromJwt)
  response.headers.set('x-pathname', pathname)
  return response
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|api/auth|api/webhook).*)',
  ],
}
