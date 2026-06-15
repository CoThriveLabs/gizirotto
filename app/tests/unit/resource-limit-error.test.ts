/**
 * ResourceLimitError 配線テスト
 *
 * 検証内容:
 *   1. ResourceLimitError クラスの基本プロパティ (name / message / resource / scope)
 *   2. mapDbErrorToResourceLimit: 議事録上限 / テンプレ上限 / 無関係エラー 3 パターン
 *   3. createMinute: minutes INSERT トリガ raise (P0001 + hint=family_resource_limit) を
 *      ResourceLimitError('minutes') に変換して throw すること
 *   4. createMinute: 通常 DB エラー (上限以外) は素通しで throw されること (既存挙動温存)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ResourceLimitError,
  mapDbErrorToResourceLimit,
} from '@/lib/db-error-mapper'

// ---- 1. ResourceLimitError クラス ----
describe('ResourceLimitError', () => {
  it('minutes インスタンスは正しい name/message/resource/scope を持つ', () => {
    const e = new ResourceLimitError('minutes')
    expect(e).toBeInstanceOf(Error)
    expect(e).toBeInstanceOf(ResourceLimitError)
    expect(e.name).toBe('ResourceLimitError')
    expect(e.message).toBe('RESOURCE_LIMIT_EXCEEDED')
    expect(e.resource).toBe('minutes')
    expect(e.scope).toBe('family')
  })

  it('templates インスタンスは resource=templates を持つ', () => {
    const e = new ResourceLimitError('templates')
    expect(e.resource).toBe('templates')
    expect(e.scope).toBe('family')
  })
})

// ---- 2. mapDbErrorToResourceLimit ----
describe('mapDbErrorToResourceLimit', () => {
  it('議事録上限エラー (P0001 + 議事録 message) を minutes resource にマップ', () => {
    const res = mapDbErrorToResourceLimit({
      code: 'P0001',
      hint: 'family_resource_limit',
      message: '議事録の今月上限（100）に達しました',
    })
    expect(res).not.toBeNull()
    expect(res?.status).toBe(429)
    expect(res?.body.code).toBe('RESOURCE_LIMIT_EXCEEDED')
    expect(res?.body.resource).toBe('minutes')
  })

  it('テンプレ上限エラー (P0001 + テンプレ message) を templates resource にマップ', () => {
    const res = mapDbErrorToResourceLimit({
      code: 'P0001',
      hint: 'family_resource_limit',
      message: 'テンプレ累積上限（50）に達しました',
    })
    expect(res?.body.resource).toBe('templates')
  })

  it('hint が一致しない P0001 は null を返す (副作用回避)', () => {
    const res = mapDbErrorToResourceLimit({
      code: 'P0001',
      hint: 'other_constraint',
      message: '別の制約違反',
    })
    expect(res).toBeNull()
  })

  it('errcode が P0001 以外は null を返す', () => {
    const res = mapDbErrorToResourceLimit({
      code: '23505',
      hint: 'family_resource_limit',
      message: 'unique violation',
    })
    expect(res).toBeNull()
  })

  it('error 自体が null/undefined のときも安全に null を返す', () => {
    expect(mapDbErrorToResourceLimit(null)).toBeNull()
    expect(mapDbErrorToResourceLimit(undefined)).toBeNull()
  })
})

// ---- 3 & 4. createMinute 配線 ----
// Supabase / 周辺の重い依存を mock してから createMinute を import する。
// 各 mock の参照は module スコープで定義し、テストごとに mockReset する。
const authGetUserMock = vi.fn()
const authGetSessionMock = vi.fn()
const tplMaybeSingleMock = vi.fn()
const insertSingleMock = vi.fn()
const revalidatePathMock = vi.fn()
const regenerateMinutePdfMock = vi.fn()
const decodeAccessTokenClaimsMock = vi.fn()
const createServiceClientMock = vi.fn()

vi.mock('next/cache', () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}))

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(async () => buildSupabaseMock()),
}))

vi.mock('@/lib/supabase/service', () => ({
  createSupabaseServiceClient: () => createServiceClientMock(),
}))

vi.mock('@/lib/jwt-claims', () => ({
  decodeAccessTokenClaims: (...args: unknown[]) =>
    decodeAccessTokenClaimsMock(...args),
}))

vi.mock('@/lib/pdf-output/regenerate-minute-pdf', () => ({
  regenerateMinutePdf: (...args: unknown[]) => regenerateMinutePdfMock(...args),
}))

// builtin bbox は今回の検証範囲外。fields=null で側枠だけ通せれば良い。
vi.mock('@/lib/builtin-bbox-loader', () => ({
  loadBuiltinBboxOverrides: vi.fn(async () => null),
  resolveBuiltinBboxSlugFromProcessedPath: vi.fn(() => null),
}))

function buildSupabaseMock() {
  // from('templates') と from('minutes') を切り替える chained mock。
  return {
    auth: {
      getUser: authGetUserMock,
      getSession: authGetSessionMock,
    },
    from: (table: string) => {
      if (table === 'templates') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: tplMaybeSingleMock,
            }),
          }),
        }
      }
      if (table === 'minutes') {
        return {
          insert: () => ({
            select: () => ({
              single: insertSingleMock,
            }),
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

describe('createMinute: ResourceLimitError 配線', () => {
  beforeEach(() => {
    vi.resetModules()
    authGetUserMock.mockReset()
    authGetSessionMock.mockReset()
    tplMaybeSingleMock.mockReset()
    insertSingleMock.mockReset()
    revalidatePathMock.mockReset()
    regenerateMinutePdfMock.mockReset()
    decodeAccessTokenClaimsMock.mockReset()
    createServiceClientMock.mockReset()

    authGetUserMock.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    authGetSessionMock.mockResolvedValue({
      data: { session: { access_token: 'jwt-fake' } },
    })
    decodeAccessTokenClaimsMock.mockReturnValue({ family_id: 'fam-1' })
    // user テンプレ扱い (builtin bbox 早期 return)
    tplMaybeSingleMock.mockResolvedValue({
      data: { family_id: 'fam-1', processed_path: 'fam-1/tpl.docx' },
    })
    regenerateMinutePdfMock.mockResolvedValue({ ok: true })
    createServiceClientMock.mockReturnValue({})
  })

  it('議事録月次上限 DB トリガ raise → ResourceLimitError(minutes) を throw', async () => {
    insertSingleMock.mockResolvedValue({
      data: null,
      error: {
        code: 'P0001',
        hint: 'family_resource_limit',
        message: '議事録の今月上限（100）に達しました',
      },
    })

    const { createMinute } = await import('@/server/minutes')
    // resetModules 後の動的 import 経路で得た同一インスタンスを比較に使う
    // (top-level import 由来のクラスとは別インスタンスになる)
    const mapper = await import('@/lib/db-error-mapper')

    let caught: unknown = null
    try {
      await createMinute({
        templateId: '11111111-1111-1111-1111-111111111111',
        title: 'test',
        meetingDate: '2026-06-12',
        content: { foo: 'bar' },
      })
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(mapper.ResourceLimitError)
    expect((caught as InstanceType<typeof mapper.ResourceLimitError>).resource).toBe(
      'minutes',
    )
    expect((caught as InstanceType<typeof mapper.ResourceLimitError>).scope).toBe(
      'family',
    )
    expect((caught as Error).message).toBe('RESOURCE_LIMIT_EXCEEDED')
    expect((caught as Error).name).toBe('ResourceLimitError')
  })

  it('上限以外の DB エラー (例: NOT NULL 違反) は素通しで throw される (既存挙動温存)', async () => {
    const dbErr = {
      code: '23502',
      hint: null,
      message: 'null value in column "family_id" violates not-null constraint',
    }
    insertSingleMock.mockResolvedValue({ data: null, error: dbErr })

    const { createMinute } = await import('@/server/minutes')
    const mapper = await import('@/lib/db-error-mapper')

    let caught: unknown = null
    try {
      await createMinute({
        templateId: '11111111-1111-1111-1111-111111111111',
        title: 'test',
        meetingDate: '2026-06-12',
        content: { foo: 'bar' },
      })
    } catch (e) {
      caught = e
    }

    expect(caught).not.toBeInstanceOf(mapper.ResourceLimitError)
    // 元エラーオブジェクトがそのまま伝播
    expect(caught).toEqual(dbErr)
  })

  it('正常系: INSERT 成功時は ResourceLimitError は throw されず id を返す', async () => {
    insertSingleMock.mockResolvedValue({ data: { id: 'min-1' }, error: null })

    const { createMinute } = await import('@/server/minutes')

    const result = await createMinute({
      templateId: '11111111-1111-1111-1111-111111111111',
      title: 'test',
      meetingDate: '2026-06-12',
      content: { foo: 'bar' },
    })

    expect(result).toEqual({ id: 'min-1' })
  })
})
