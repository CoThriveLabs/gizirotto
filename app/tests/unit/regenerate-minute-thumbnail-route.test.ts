import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * /api/minutes/[id]/regenerate-thumbnail route の認可 / 経路分岐テスト。
 *
 * generateMinuteThumbnail の result.ok===false → 500 / result.ok===true → 200。
 *
 * 検証主眼:
 *   - JWT 未認証 → 401
 *   - minute 不在 → 404
 *   - builtin (family_id=null) → 400 BUILTIN_NOT_REGENERABLE
 *   - family 非所属 → 403 FORBIDDEN
 *   - generateMinuteThumbnail fail → 500（内部 markFailed 済前提・route で重ね打ち禁止）
 *   - 成功 → 200 + thumbnail_path
 */

const genThumbMock = vi.fn()
vi.mock('@/lib/pdf-output/minute-thumbnail', () => ({
  generateMinuteThumbnail: (...args: unknown[]) => genThumbMock(...args),
}))

const createClientMock = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: () => createClientMock(),
}))

import { POST } from '@/app/api/minutes/[id]/regenerate-thumbnail/route'

interface MinuteRow {
  id: string
  family_id: string | null
}

function makeSupabaseStub(opts: {
  user?: { id: string } | null
  minute: MinuteRow | null
  memberRow?: { user_id: string } | null
}) {
  return {
    auth: {
      getUser: () =>
        Promise.resolve({
          data: { user: 'user' in opts ? opts.user : { id: 'u1' } },
        }),
    },
    from: (table: string) => {
      if (table === 'minutes') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: opts.minute, error: null }),
            }),
          }),
        }
      }
      // family_members
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data:
                    'memberRow' in opts ? opts.memberRow : { user_id: 'u1' },
                  error: null,
                }),
            }),
          }),
        }),
      }
    },
  }
}

const makeRequest = () => ({}) as never
const params = Promise.resolve({ id: 'min1' })

describe('/api/minutes/[id]/regenerate-thumbnail (v1.2 raw 起点)', () => {
  beforeEach(() => {
    genThumbMock.mockReset()
    createClientMock.mockReset()
    genThumbMock.mockResolvedValue({
      ok: true,
      thumbnailPath: 'fam1/minutes/min1_72_png.png',
    })
  })

  it('未認証 → 401', async () => {
    createClientMock.mockResolvedValue(
      makeSupabaseStub({ user: null, minute: null }),
    )
    const res = await POST(makeRequest(), { params })
    expect(res.status).toBe(401)
  })

  it('minute 不在 → 404', async () => {
    createClientMock.mockResolvedValue(makeSupabaseStub({ minute: null }))
    const res = await POST(makeRequest(), { params })
    expect(res.status).toBe(404)
  })

  it('builtin (family_id=null) → 400 BUILTIN_NOT_REGENERABLE', async () => {
    createClientMock.mockResolvedValue(
      makeSupabaseStub({
        minute: { id: 'min1', family_id: null },
      }),
    )
    const res = await POST(makeRequest(), { params })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('BUILTIN_NOT_REGENERABLE')
  })

  it('family 非所属 → 403 FORBIDDEN', async () => {
    createClientMock.mockResolvedValue(
      makeSupabaseStub({
        minute: { id: 'min1', family_id: 'fam1' },
        memberRow: null,
      }),
    )
    const res = await POST(makeRequest(), { params })
    expect(res.status).toBe(403)
  })

  it('raw PDF 取得失敗（generateMinuteThumbnail で RAW_FETCH_FAILED） → 500', async () => {
    genThumbMock.mockResolvedValueOnce({ ok: false, code: 'RAW_FETCH_FAILED' })
    createClientMock.mockResolvedValue(
      makeSupabaseStub({
        minute: { id: 'min1', family_id: 'fam1' },
      }),
    )
    const res = await POST(makeRequest(), { params })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.code).toBe('RAW_FETCH_FAILED')
  })

  it('overlay 合成失敗（RENDER_FAILED） → 500', async () => {
    genThumbMock.mockResolvedValueOnce({ ok: false, code: 'RENDER_FAILED' })
    createClientMock.mockResolvedValue(
      makeSupabaseStub({
        minute: { id: 'min1', family_id: 'fam1' },
      }),
    )
    const res = await POST(makeRequest(), { params })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.code).toBe('RENDER_FAILED')
  })

  it('正常系 → 200 + generateMinuteThumbnail に minuteId のみ渡される', async () => {
    createClientMock.mockResolvedValue(
      makeSupabaseStub({
        minute: { id: 'min1', family_id: 'fam1' },
      }),
    )
    const res = await POST(makeRequest(), { params })
    expect(res.status).toBe(200)
    expect(genThumbMock).toHaveBeenCalledTimes(1)
    // v1.2: シグネチャは { minuteId } のみ
    expect(genThumbMock.mock.calls[0][1]).toEqual({ minuteId: 'min1' })
    const body = await res.json()
    expect(body).toEqual({
      ok: true,
      thumbnail_path: 'fam1/minutes/min1_72_png.png',
    })
  })
})
