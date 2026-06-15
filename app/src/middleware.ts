import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { decodeAccessTokenClaims } from '@/lib/jwt-claims'
import { ipBurstLimit } from '@/lib/ratelimit'

type CookieToSet = { name: string; value: string; options: CookieOptions }

const PUBLIC_PATHS = [
  '/login',
  '/forgot-password',
  '/reset-password',
  '/auth/callback',
  '/legal',
  '/_next',
  '/favicon.ico',
]
const FAMILY_SETUP_PATH = '/family/setup'
const STATIC_FILE_EXT = /\.(svg|png|jpg|jpeg|gif|webp|ico|css|js|map|woff2?|html)$/

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
  // 理由: 未認証 OPTIONS が redirect されると preflight が壊れ 400 になる (B-9)。
  if (request.method === 'OPTIONS') {
    const origin = request.headers.get('origin') ?? '*'
    const reqHeaders = request.headers.get('access-control-request-headers') ?? '*'
    return new NextResponse(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': reqHeaders,
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin, Access-Control-Request-Headers',
      },
    })
  }

  // Phase 1 §1-1: /api/* への IP burst 制限 (認証より前・安いチェックを先に)。
  // env 未設定環境では ipBurstLimit が noop なので既存挙動を壊さない。
  // 注: config.matcher で api/auth・api/webhook は除外済 → ここには到達しない。
  if (pathname.startsWith('/api/')) {
    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      'anonymous'
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

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p)) || STATIC_FILE_EXT.test(pathname)) {
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

    if (pathname === FAMILY_SETUP_PATH || pathname.startsWith('/family/')) {
      return response
    }

    return unauthorizedOrRedirect(
      request,
      new URL('/login', request.url),
      'UNAUTHENTICATED',
      response,
    )
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
    if (pathname.startsWith('/family/')) {
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
