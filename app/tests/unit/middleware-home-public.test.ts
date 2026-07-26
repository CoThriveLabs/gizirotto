// @vitest-environment node
// Next.js middleware は Edge Runtime 互換 Headers / Request を要求するため、
// jsdom の Headers 実装では NextResponse.next({ request }) が型不整合で落ちる。
// このファイルは node 環境（undici 系 Headers）で実行する。

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

// Supabase / JWT / ratelimit のモック
const getUser = vi.fn()
const getSession = vi.fn()
const createServerClient = vi.fn()

vi.mock('@supabase/ssr', () => ({
  createServerClient: (...args: unknown[]) => createServerClient(...args),
}))

vi.mock('@/lib/jwt-claims', () => ({
  decodeAccessTokenClaims: vi.fn(),
}))

vi.mock('@/lib/ratelimit', () => ({
  ipBurstLimit: {
    limit: vi.fn().mockResolvedValue({ success: true, reset: 0 }),
  },
}))

import { middleware } from '@/middleware'
import { decodeAccessTokenClaims } from '@/lib/jwt-claims'

function mockSupabase({
  user,
  accessToken,
}: {
  user: { id: string } | null
  accessToken?: string
}) {
  getUser.mockResolvedValue({ data: { user } })
  getSession.mockResolvedValue({
    data: { session: accessToken ? { access_token: accessToken } : null },
  })
  createServerClient.mockReturnValue({
    auth: {
      getUser,
      getSession,
    },
  })
}

/**
 * getUser() のタイミングで supabase がトークンをリフレッシュし、setAll でレスポンスに
 * cookie を載せてくる状況を再現する。middleware が redirect を返すときに、この cookie を
 * 引き継げているかを検証するために使う。
 */
function mockSupabaseWithTokenRefresh({
  user,
  accessToken,
  refreshedCookieName,
  refreshedCookieValue,
}: {
  user: { id: string } | null
  accessToken?: string
  refreshedCookieName: string
  refreshedCookieValue: string
}) {
  getSession.mockResolvedValue({
    data: { session: accessToken ? { access_token: accessToken } : null },
  })
  createServerClient.mockImplementation((_url: unknown, _key: unknown, opts: unknown) => {
    const { cookies } = opts as {
      cookies: {
        setAll: (
          c: { name: string; value: string; options: Record<string, unknown> }[],
        ) => void
      }
    }
    return {
      auth: {
        getUser: async () => {
          cookies.setAll([
            {
              name: refreshedCookieName,
              value: refreshedCookieValue,
              options: { path: '/', maxAge: 3600 },
            },
          ])
          return { data: { user } }
        },
        getSession,
      },
    }
  })
}

function makeReq(url: string): NextRequest {
  // NextRequest を直接 URL から生成すると、jsdom 環境下で
  // NextResponse.next({ request }) が要求する Headers 互換性を満たせない場合がある。
  // Request を経由することで Headers インスタンスを正しく確保する。
  return new NextRequest(
    new Request(new URL(url, 'http://localhost:3000').toString(), {
      method: 'GET',
      headers: new Headers({ accept: 'text/html' }),
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'test-key'
})

describe('middleware home public fix', () => {
  it('TC-1: 未ログイン user が / を GET → 通過 + redirect なし + x-family-id なし', async () => {
    mockSupabase({ user: null })
    ;(decodeAccessTokenClaims as ReturnType<typeof vi.fn>).mockReturnValue(null)

    const res = await middleware(makeReq('/'))

    expect(res.headers.get('location')).toBeNull()
    expect(res.headers.get('x-family-id')).toBeNull()
  })

  it('TC-2: ログイン済 + family_id あり で / を GET → 通過 + x-family-id 注入', async () => {
    mockSupabase({ user: { id: 'u1' }, accessToken: 'tok' })
    ;(decodeAccessTokenClaims as ReturnType<typeof vi.fn>).mockReturnValue({
      family_id: 'fam-001',
    })

    const res = await middleware(makeReq('/'))

    expect(res.headers.get('location')).toBeNull()
    expect(res.headers.get('x-family-id')).toBe('fam-001')
    expect(res.headers.get('x-pathname')).toBe('/')
  })

  it('TC-3: ログイン済 + family 未設定 で / を GET → 通過 + x-family-id 注入なし + setup へ redirect なし', async () => {
    mockSupabase({ user: { id: 'u1' }, accessToken: 'tok' })
    ;(decodeAccessTokenClaims as ReturnType<typeof vi.fn>).mockReturnValue({
      family_id: null,
    })

    const res = await middleware(makeReq('/'))

    expect(res.headers.get('location')).toBeNull()
    expect(res.headers.get('x-family-id')).toBeNull()
  })

  it('TC-4: 未ログイン user が /minutes を GET → /login?next= に redirect', async () => {
    mockSupabase({ user: null })

    const res = await middleware(makeReq('/minutes'))

    const location = res.headers.get('location') ?? ''
    expect(location).toContain('/login')
    expect(location).toContain('next=%2Fminutes')
  })

  it('TC-5: 未ログイン user が /legal/privacy を GET → 通過（PUBLIC_PATHS prefix 早期 return）', async () => {
    const res = await middleware(makeReq('/legal/privacy'))

    expect(res.headers.get('location')).toBeNull()
    // 早期 return のため Supabase クライアントは生成されない
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('TC-6: 未ログイン user が /family/join?code=ABC を GET → /login?next= に redirect', async () => {
    mockSupabase({ user: null })

    const res = await middleware(makeReq('/family/join?code=ABC'))

    const location = res.headers.get('location') ?? ''
    expect(location).toContain('/login')
    expect(location).toContain('next=')
  })

  it('TC-8: family 参加済で /family/setup?next=... → next へ redirect（next を捨てない）', async () => {
    mockSupabase({ user: { id: 'u1' }, accessToken: 'tok' })
    ;(decodeAccessTokenClaims as ReturnType<typeof vi.fn>).mockReturnValue({
      family_id: 'fam-001',
    })

    const res = await middleware(
      makeReq('/family/setup?next=%2Fminutes%2Fnew%2Fmanual%3Ftemplate_id%3Dt1'),
    )

    expect(res.headers.get('location')).toBe(
      'http://localhost:3000/minutes/new/manual?template_id=t1',
    )
  })

  it('TC-9: family 参加済で /family/setup?next=//evil.com → / へ redirect（不正 next は破棄）', async () => {
    mockSupabase({ user: { id: 'u1' }, accessToken: 'tok' })
    ;(decodeAccessTokenClaims as ReturnType<typeof vi.fn>).mockReturnValue({
      family_id: 'fam-001',
    })

    const res = await middleware(makeReq('/family/setup?next=%2F%2Fevil.com'))

    expect(res.headers.get('location')).toBe('http://localhost:3000/')
  })

  it('TC-10: family 参加済で /family/setup（next なし）→ / へ redirect', async () => {
    mockSupabase({ user: { id: 'u1' }, accessToken: 'tok' })
    ;(decodeAccessTokenClaims as ReturnType<typeof vi.fn>).mockReturnValue({
      family_id: 'fam-001',
    })

    const res = await middleware(makeReq('/family/setup'))

    expect(res.headers.get('location')).toBe('http://localhost:3000/')
  })

  it('TC-11: family 参加済で /family/setup?next=/family/setup → / へ redirect（自己参照は弾く）', async () => {
    mockSupabase({ user: { id: 'u1' }, accessToken: 'tok' })
    ;(decodeAccessTokenClaims as ReturnType<typeof vi.fn>).mockReturnValue({
      family_id: 'fam-001',
    })

    const res = await middleware(
      makeReq('/family/setup?next=%2Ffamily%2Fsetup'),
    )

    expect(res.headers.get('location')).toBe('http://localhost:3000/')
  })

  it('TC-12: /family/setup からの redirect でリフレッシュ済み認証 cookie を落とさない', async () => {
    mockSupabaseWithTokenRefresh({
      user: { id: 'u1' },
      accessToken: 'tok',
      refreshedCookieName: 'sb-test-auth-token',
      refreshedCookieValue: 'refreshed-value',
    })
    ;(decodeAccessTokenClaims as ReturnType<typeof vi.fn>).mockReturnValue({
      family_id: 'fam-001',
    })

    const res = await middleware(makeReq('/family/setup'))

    expect(res.headers.get('location')).toBe('http://localhost:3000/')
    const cookie = res.cookies.get('sb-test-auth-token')
    expect(cookie?.value).toBe('refreshed-value')
    // 値だけ引き継いで options を落とすと maxAge 消失＝セッション cookie 化し、
    // ブラウザを閉じるとログアウトされる。属性まで含めて引き継ぐこと。
    expect(cookie?.maxAge).toBe(3600)
    expect(cookie?.path).toBe('/')
  })

  it('TC-13: 未認証 redirect でも cookie を引き継ぐ（既存 unauthorizedOrRedirect の挙動）', async () => {
    mockSupabaseWithTokenRefresh({
      user: null,
      refreshedCookieName: 'sb-test-auth-token',
      refreshedCookieValue: 'refreshed-value',
    })

    const res = await middleware(makeReq('/minutes'))

    expect(res.headers.get('location') ?? '').toContain('/login')
    const cookie = res.cookies.get('sb-test-auth-token')
    expect(cookie?.value).toBe('refreshed-value')
    expect(cookie?.maxAge).toBe(3600)
    expect(cookie?.path).toBe('/')
  })

  it('TC-7: ログイン済 + family 未参加 で /api/consent を GET → 通過（/family/setup へ redirect しない）', async () => {
    mockSupabase({ user: { id: 'u1' }, accessToken: 'tok' })
    ;(decodeAccessTokenClaims as ReturnType<typeof vi.fn>).mockReturnValue({
      family_id: null,
    })

    const res = await middleware(makeReq('/api/consent'))

    expect(res.headers.get('location')).toBeNull()
    expect(res.status).not.toBe(401)
  })
})
