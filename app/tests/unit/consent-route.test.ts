/**
 * /api/consent POST route handler unit test
 *
 * 検証項目:
 *   1. 同一 user / terms_version / privacy_version の行が既にあれば INSERT せず { ok: true }
 *   2. 既存行が無ければ INSERT する
 *   3. 既存行が旧バージョンなら（規約改定）新バージョンで INSERT する
 *   4. 既存確認の SELECT が失敗したら INSERT に進む（記録漏れを避けるフォールバック）
 *   5. 未認証（getUser() が null）は 401
 *   6. termsAgreed / privacyAgreed が false なら 400（Supabase に触れない）
 *   7. INSERT 失敗は 500
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TERMS_VERSION, PRIVACY_VERSION } from '@/lib/legal/versions'

const getUserMock = vi.fn()
const maybeSingleMock = vi.fn()
const insertMock = vi.fn()
const selectMock = vi.fn()
const eqMock = vi.fn()

/**
 * route は select→eq×3→limit→maybeSingle をチェーンで呼ぶ。同じ builder を返し続けることで
 * 呼び出し順に依存せず、終端（maybeSingle / insert）だけをテストから制御する。
 */
function makeQueryBuilder() {
  const builder: Record<string, unknown> = {}
  builder.select = (...args: unknown[]) => {
    selectMock(...args)
    return builder
  }
  builder.eq = (...args: unknown[]) => {
    eqMock(...args)
    return builder
  }
  builder.limit = () => builder
  builder.maybeSingle = () => maybeSingleMock()
  builder.insert = (...args: unknown[]) => insertMock(...args)
  return builder
}

const fromMock = vi.fn((_table: string) => makeQueryBuilder())

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      auth: { getUser: getUserMock },
      from: (table: string) => fromMock(table),
    }),
}))

import { POST } from '@/app/api/consent/route'

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3000/api/consent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

const AGREED = { termsAgreed: true, privacyAgreed: true }

beforeEach(() => {
  vi.clearAllMocks()
  getUserMock.mockResolvedValue({ data: { user: { id: 'user-1' } } })
  maybeSingleMock.mockResolvedValue({ data: null, error: null })
  insertMock.mockResolvedValue({ error: null })
})

describe('/api/consent POST — 冪等化', () => {
  it('同一 user / 同一バージョンの既存行があれば INSERT せず { ok: true }', async () => {
    maybeSingleMock.mockResolvedValue({ data: { id: 'consent-1' }, error: null })

    const res = await POST(makeRequest(AGREED))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(insertMock).not.toHaveBeenCalled()
    // 現行バージョンで絞り込んでいること（旧バージョンの行を再利用しない）。
    expect(eqMock).toHaveBeenCalledWith('user_id', 'user-1')
    expect(eqMock).toHaveBeenCalledWith('terms_version', TERMS_VERSION)
    expect(eqMock).toHaveBeenCalledWith('privacy_version', PRIVACY_VERSION)
  })

  it('既存行が無ければ INSERT する', async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: null })

    const res = await POST(makeRequest(AGREED, { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(insertMock).toHaveBeenCalledTimes(1)
    expect(insertMock).toHaveBeenCalledWith({
      user_id: 'user-1',
      terms_version: TERMS_VERSION,
      privacy_version: PRIVACY_VERSION,
      ip_address: '203.0.113.9',
    })
  })

  it('既存行が旧バージョンなら（規約改定シナリオ）新バージョンで INSERT する', async () => {
    // DB には旧バージョンの同意行しか無い状態を模す。SELECT が現行バージョンで絞っていれば
    // 0 件（= 新バージョンで INSERT が必要）、バージョン条件を落とすと旧行がヒットして
    // INSERT がスキップされ、規約改定後の同意が記録されなくなる。
    const STALE_VERSION = '0.0.1-old'
    maybeSingleMock.mockImplementation(() => {
      const filtersCurrentVersion = eqMock.mock.calls.some(
        ([col, val]) =>
          (col === 'terms_version' && val === TERMS_VERSION) ||
          (col === 'privacy_version' && val === PRIVACY_VERSION),
      )
      return Promise.resolve({
        data: filtersCurrentVersion
          ? null
          : {
              id: 'consent-old',
              terms_version: STALE_VERSION,
              privacy_version: STALE_VERSION,
            },
        error: null,
      })
    })

    const res = await POST(makeRequest(AGREED))

    expect(res.status).toBe(200)
    expect(insertMock).toHaveBeenCalledTimes(1)
    expect(insertMock).toHaveBeenCalledWith({
      user_id: 'user-1',
      terms_version: TERMS_VERSION,
      privacy_version: PRIVACY_VERSION,
      ip_address: null,
    })
  })

  it('既存確認の SELECT が失敗しても INSERT に進む（記録漏れ回避）', async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: { message: 'select failed' } })

    const res = await POST(makeRequest(AGREED))

    expect(res.status).toBe(200)
    expect(insertMock).toHaveBeenCalledTimes(1)
  })

  it('INSERT が失敗したら 500', async () => {
    insertMock.mockResolvedValue({ error: { message: 'insert failed' } })

    const res = await POST(makeRequest(AGREED))

    expect(res.status).toBe(500)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBeTruthy()
  })
})

describe('/api/consent POST — 入力・認証チェック', () => {
  it('未認証（getUser() が null）は 401 で INSERT しない', async () => {
    getUserMock.mockResolvedValue({ data: { user: null } })

    const res = await POST(makeRequest(AGREED))

    expect(res.status).toBe(401)
    expect(insertMock).not.toHaveBeenCalled()
  })

  it('termsAgreed が false なら 400（Supabase に触れない）', async () => {
    const res = await POST(makeRequest({ termsAgreed: false, privacyAgreed: true }))

    expect(res.status).toBe(400)
    expect(getUserMock).not.toHaveBeenCalled()
    expect(insertMock).not.toHaveBeenCalled()
  })

  it('privacyAgreed が false なら 400', async () => {
    const res = await POST(makeRequest({ termsAgreed: true, privacyAgreed: false }))

    expect(res.status).toBe(400)
    expect(insertMock).not.toHaveBeenCalled()
  })

  it('body が JSON として壊れていても 400 で落ちる', async () => {
    const req = new Request('http://localhost:3000/api/consent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    })

    const res = await POST(req)

    expect(res.status).toBe(400)
    expect(insertMock).not.toHaveBeenCalled()
  })
})
