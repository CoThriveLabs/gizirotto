// @vitest-environment node
/**
 * (public-flow)/minutes/new/adjust/page.tsx — guestTemplateLimit 接続テスト。
 *
 * Server Component を関数として直接呼び出し、返り値の React element tree /
 * next/navigation redirect() 呼び出しを検証する（redirect/notFound は throw する
 * sentinel にモックし、呼出し以降のコードが実行されないことも併せて確認する）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.mock factories are hoisted above all imports/consts, so the mock fns they close
// over must be declared via vi.hoisted (plain `const x = vi.fn()` above vi.mock would
// throw "Cannot access before initialization").
const {
  redirectMock,
  notFoundMock,
  getUserMock,
  guestTemplateLimitMock,
  getTemplateMock,
  buildAdjustInitialPropsMock,
} = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`)
  }),
  notFoundMock: vi.fn(() => {
    throw new Error('NOT_FOUND')
  }),
  getUserMock: vi.fn(),
  guestTemplateLimitMock: vi.fn(),
  getTemplateMock: vi.fn(),
  buildAdjustInitialPropsMock: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  redirect: redirectMock,
  notFound: notFoundMock,
}))

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ 'x-forwarded-for': '9.9.9.9' })),
}))

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn().mockResolvedValue({
    auth: { getUser: (...args: unknown[]) => getUserMock(...args) },
  }),
}))

vi.mock('@/lib/ratelimit', () => ({
  guestTemplateLimit: { limit: (...args: unknown[]) => guestTemplateLimitMock(...args) },
}))

vi.mock('@/server/templates', () => ({
  getTemplate: (...args: unknown[]) => getTemplateMock(...args),
}))

vi.mock('@/app/(dashboard)/minutes/[id]/adjust/build-initial-props', () => ({
  buildAdjustInitialProps: (...args: unknown[]) => buildAdjustInitialPropsMock(...args),
}))

vi.mock('@/app/(public-flow)/minutes/new/adjust/GuestAdjustBootstrap', () => ({
  GuestAdjustBootstrap: () => null,
}))
vi.mock('@/app/(public-flow)/minutes/new/adjust/GuestTemplateLimitReached', () => ({
  GuestTemplateLimitReached: () => null,
}))

import MinutesNewAdjustPage from '@/app/(public-flow)/minutes/new/adjust/page'
import { GuestAdjustBootstrap } from '@/app/(public-flow)/minutes/new/adjust/GuestAdjustBootstrap'
import { GuestTemplateLimitReached } from '@/app/(public-flow)/minutes/new/adjust/GuestTemplateLimitReached'

type AnyElement = { type: unknown; props: Record<string, unknown> }

const BUILTIN_ID = '00000000-0000-0000-0000-000000000001'

function searchParams(params: Record<string, string>) {
  return Promise.resolve(params)
}

beforeEach(() => {
  redirectMock.mockClear()
  notFoundMock.mockClear()
  getUserMock.mockReset()
  guestTemplateLimitMock.mockReset()
  getTemplateMock.mockReset()
  buildAdjustInitialPropsMock.mockReset()
  getUserMock.mockResolvedValue({ data: { user: null } })
  getTemplateMock.mockResolvedValue({ name: 'テスト', fields: [], fixed_texts: [] })
  buildAdjustInitialPropsMock.mockResolvedValue({
    fields: [],
    pdfFields: [],
    initialOverrides: {},
    initialValues: {},
    fixedTextSizesPt: [],
  })
})

describe('MinutesNewAdjustPage — guestTemplateLimit 接続', () => {
  it('ログイン済みユーザーは guestTemplateLimit を消費せず /minutes/new/manual へ redirect する（早期return順序）', async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: 'u1' } } })
    await expect(
      MinutesNewAdjustPage({ searchParams: searchParams({ template_id: BUILTIN_ID }) }),
    ).rejects.toThrow(`REDIRECT:/minutes/new/manual?template_id=${BUILTIN_ID}`)
    expect(guestTemplateLimitMock).not.toHaveBeenCalled()
    expect(getTemplateMock).not.toHaveBeenCalled()
  })

  it('ゲストで guestTemplateLimit success:true → 通常通り GuestAdjustBootstrap まで到達する', async () => {
    guestTemplateLimitMock.mockResolvedValue({ success: true, reset: 0, remaining: 1 })

    const result = (await MinutesNewAdjustPage({
      searchParams: searchParams({ template_id: BUILTIN_ID }),
    })) as unknown as AnyElement

    expect(guestTemplateLimitMock).toHaveBeenCalledWith('ip:9.9.9.9')
    expect(getTemplateMock).toHaveBeenCalledWith(BUILTIN_ID)

    const children = result.props.children as AnyElement[]
    const bootstrapEl = children.find((c) => c && c.type === GuestAdjustBootstrap)
    expect(bootstrapEl, 'GuestAdjustBootstrap が children に含まれること').toBeDefined()
    expect(bootstrapEl!.props.templateId).toBe(BUILTIN_ID)
  })

  it('ゲストで guestTemplateLimit success:false → GuestTemplateLimitReached を返し、テンプレを一切読まない', async () => {
    guestTemplateLimitMock.mockResolvedValue({ success: false, reset: 123456, remaining: 0 })

    const result = (await MinutesNewAdjustPage({
      searchParams: searchParams({ template_id: BUILTIN_ID }),
    })) as unknown as AnyElement

    expect(result.type).toBe(GuestTemplateLimitReached)
    expect(result.props.resetAt).toBe(123456)
    // 上限到達時は getTemplate / buildAdjustInitialProps を一切呼ばない
    // （guestTemplateLimit のみで守り、それ以降の DB / 計算処理へ進ませない）。
    expect(getTemplateMock).not.toHaveBeenCalled()
    expect(buildAdjustInitialPropsMock).not.toHaveBeenCalled()
  })
})
