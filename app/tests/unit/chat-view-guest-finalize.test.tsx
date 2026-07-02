/**
 * ChatView — isGuest=true での onFinalize（「議事録にする」）着地先テスト。
 *
 * ゲスト分岐は createMinute を呼ばない。extractFieldsFromChat は未認証だと UNAUTHENTICATED で
 * reject される（既存仕様・本ファイルの対象外）ため、ChatView 側の既存 catch フォールバック
 * （メモ詰め content）を前提に検証する。
 *
 * guest-chat-draft は form-cache（localStorage・TTL 付き）経由で書かれるため、生の
 * localStorage キーではなく makeFormCacheKey(guestChatDraftFormId(...)) 越しに読み、
 * { savedAt, expectedPath, values } でラップされた形から values を取り出して検証する。
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act, waitFor, screen, fireEvent } from '@testing-library/react'
import { makeFormCacheKey } from '@/lib/utils/form-cache'
import { guestChatDraftFormId } from '@/lib/utils/guest-adjust-draft'

function readChatDraftValues(templateId: string): {
  content: Record<string, string>
  meetingDate: string
} {
  const raw = localStorage.getItem(makeFormCacheKey(guestChatDraftFormId(templateId)))
  if (!raw) throw new Error('chat-draft not found in localStorage')
  const entry = JSON.parse(raw) as {
    values: { content: Record<string, string>; meetingDate: string }
  }
  return entry.values
}

const pushMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/minutes/new/chat',
}))

const createChatSessionMock = vi.fn()
const persistChatTurnMock = vi.fn()
const extractFieldsFromChatMock = vi.fn()
const createMinuteMock = vi.fn()
vi.mock('@/server/chat-sessions', () => ({
  createChatSession: (...args: unknown[]) => createChatSessionMock(...args),
  persistChatTurn: (...args: unknown[]) => persistChatTurnMock(...args),
  extractFieldsFromChat: (...args: unknown[]) => extractFieldsFromChatMock(...args),
}))
vi.mock('@/server/minutes', () => ({
  createMinute: (...args: unknown[]) => createMinuteMock(...args),
}))

// Turnstile モックの挙動を各テストで切り替えられるよう外部変数で制御する。
// autoToken: mount 時に即トークンを発火するか（GA2/GA4 系の既存テスト = true）
// GA5 系（race 検証）は false にして、テスト内で明示的に手動発火する。
const turnstileControls = {
  autoToken: true as boolean,
  latestOnToken: null as ((t: string) => void) | null,
  latestRef: null as { current: { reset: () => void } | null } | null,
  resetMock: vi.fn(),
}
vi.mock('@/components/auth/TurnstileWidget', () => ({
  TurnstileWidget: React.forwardRef(
    ({ onToken }: { onToken: (t: string) => void }, ref) => {
      turnstileControls.latestOnToken = onToken
      // ref callback を叩いて gate.bindWidget を呼ぶ（AdjustView/ChatView 側は ref callback 経由）。
      if (typeof ref === 'function') {
        ref({ reset: turnstileControls.resetMock })
      } else if (ref && typeof ref === 'object') {
        ref.current = { reset: turnstileControls.resetMock }
      }
      // 既存テスト互換: 初期化直後に即トークン発火。
      if (turnstileControls.autoToken) {
        onToken('dummy-turnstile-token')
      }
      return null
    },
  ),
}))
vi.mock('@/components/usage/limit-modal', () => ({
  LimitModal: () => null,
}))
// GA7: renderWithGizirotto は {node, usedInThisText} を返す形に変わった。
vi.mock('@/components/chat/renderWithGizirotto', () => ({
  renderWithGizirotto: (text: string) => ({ node: text, usedInThisText: 0 }),
  GIZIROTTO_MAX_TOTAL: 2,
}))
vi.mock('@/components/GizirottoIcon', () => ({
  GizirottoIcon: () => null,
}))
vi.mock('@/lib/errors/user-message', () => ({
  humanizeErrorCode: (code: string) => ({ message: code }),
}))
vi.mock('@/lib/db-error-mapper', () => ({
  ResourceLimitError: class ResourceLimitError extends Error {
    resource = 'minutes'
    constructor() {
      super('RESOURCE_LIMIT_EXCEEDED')
    }
  },
}))

function makeSseStream(events: string[] = ['data: {"type":"done"}\n\n']): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let idx = 0
  return new ReadableStream({
    pull(controller) {
      if (idx < events.length) {
        controller.enqueue(encoder.encode(events[idx++]))
      } else {
        controller.close()
      }
    },
  })
}

/**
 * fetch mock: URL で /api/minutes/chat/extract-fields と chat/stream を判別する。
 * extractFieldsResult 省略時は ok:false（guestAiGate 失敗相当）＝ 既存 memo dump
 * フォールバックへ落ちる既定挙動（GA4 導入前と同じテスト前提を維持）。
 * chatStreamStatus / chatStreamBody で /api/minutes/chat/stream 応答も差し替え可能
 * （GA6 の GUEST_AI_DAILY_LIMIT テスト用）。
 */
function makeFetchMock(
  extractFieldsResult: {
    ok: boolean
    status?: number
    values?: Record<string, string>
    meetingDate?: string
  } = {
    ok: false,
    status: 429,
  },
  chatStream: { status?: number; body?: Record<string, unknown> } = {},
) {
  return vi.fn().mockImplementation((url: unknown) => {
    if (typeof url === 'string' && url.includes('/api/minutes/chat/extract-fields')) {
      const jsonBody: Record<string, unknown> = { values: extractFieldsResult.values ?? {} }
      // GA8: meetingDate が指定されていればレスポンス JSON に含める（route の実挙動を模倣）。
      if (extractFieldsResult.meetingDate !== undefined) {
        jsonBody.meetingDate = extractFieldsResult.meetingDate
      }
      return Promise.resolve({
        ok: extractFieldsResult.ok,
        status: extractFieldsResult.status ?? (extractFieldsResult.ok ? 200 : 429),
        json: vi.fn().mockResolvedValue(jsonBody),
      })
    }
    // chat/stream 応答をテスト側で差し替え可能に。既定は 200 + SSE ストリーム。
    if (chatStream.status !== undefined && chatStream.status !== 200) {
      return Promise.resolve({
        ok: chatStream.status < 400,
        status: chatStream.status,
        body: null,
        json: vi.fn().mockResolvedValue(chatStream.body ?? {}),
        headers: new Headers(),
      })
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      body: makeSseStream(),
      json: vi.fn().mockResolvedValue({}),
    })
  })
}

window.HTMLElement.prototype.scrollTo = vi.fn()

import { ChatView } from '@/app/(dashboard)/minutes/new/chat/ChatView'

const DEFAULT_PROPS = {
  templateId: '00000000-0000-0000-0000-000000000001',
  templateName: 'テスト',
  mode: 'A-1' as const,
  fields: [{ name: 'agenda', label: '議題' }],
}

beforeEach(() => {
  createChatSessionMock.mockReset()
  persistChatTurnMock.mockReset()
  extractFieldsFromChatMock.mockReset()
  createMinuteMock.mockReset()
  pushMock.mockReset()
  turnstileControls.autoToken = true
  turnstileControls.latestOnToken = null
  turnstileControls.resetMock.mockReset()
  localStorage.clear()
  sessionStorage.clear()
  // 非ゲスト経路でも initSession が createChatSession を呼ぶため既定の解決値を用意する
  // （ゲスト経路は crypto.randomUUID() を使うため未使用・無害）。
  createChatSessionMock.mockResolvedValue({ id: 'server-session-uuid' })
  extractFieldsFromChatMock.mockRejectedValue(new Error('UNAUTHENTICATED'))
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  sessionStorage.clear()
})

async function sendOneUserMessage(fetchMock: ReturnType<typeof makeFetchMock>) {
  await act(async () => {
    render(<ChatView {...DEFAULT_PROPS} isGuest />)
  })
  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  const textarea = screen.getByPlaceholderText(/メッセージを入力/)
  await act(async () => {
    fireEvent.change(textarea, { target: { value: 'テストメッセージ' } })
  })
  await act(async () => {
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
  })
  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  await waitFor(() => {
    expect(screen.getByRole('button', { name: '議事録にする' })).not.toBeDisabled()
  })
}

describe('ChatView — isGuest=true の onFinalize', () => {
  it('createMinute を呼ばず、guest-chat-draft を localStorage へ残してゲスト adjust ルートへ遷移する', async () => {
    const fetchMock = makeFetchMock()
    global.fetch = fetchMock
    await sendOneUserMessage(fetchMock)

    const finalizeButton = screen.getByRole('button', { name: '議事録にする' })
    await act(async () => {
      fireEvent.click(finalizeButton)
    })

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith(
        `/minutes/new/adjust?template_id=${DEFAULT_PROPS.templateId}`,
      )
    })
    expect(createMinuteMock).not.toHaveBeenCalled()
    expect(
      localStorage.getItem(makeFormCacheKey(guestChatDraftFormId(DEFAULT_PROPS.templateId))),
    ).not.toBeNull()
  })

  it('draft が見つからない field は含まれず、抽出失敗フォールバックの content がそのまま渡る', async () => {
    const fetchMock = makeFetchMock()
    global.fetch = fetchMock
    await sendOneUserMessage(fetchMock)

    const finalizeButton = screen.getByRole('button', { name: '議事録にする' })
    await act(async () => {
      fireEvent.click(finalizeButton)
    })

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalled()
    })
    const values = readChatDraftValues(DEFAULT_PROPS.templateId)
    // extractFieldsFromChat が reject → 既存 catch フォールバックで fields[0] にメモが入る。
    expect(typeof values.content.agenda).toBe('string')
    expect(values.content.agenda.length).toBeGreaterThan(0)
  })

  it('/api/minutes/chat/extract-fields を templateId/conversation 付きで呼び、成功時は values がそのまま content になる', async () => {
    const fetchMock = makeFetchMock({ ok: true, values: { agenda: '来月の旅行について話した' } })
    global.fetch = fetchMock
    await sendOneUserMessage(fetchMock)

    const finalizeButton = screen.getByRole('button', { name: '議事録にする' })
    await act(async () => {
      fireEvent.click(finalizeButton)
    })

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalled()
    })

    const extractCall = fetchMock.mock.calls.find(
      (call) =>
        typeof call[0] === 'string' && call[0].includes('/api/minutes/chat/extract-fields'),
    )
    expect(extractCall, 'extract-fields route が呼ばれること').toBeDefined()
    const init = extractCall![1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      templateId: string
      conversation: unknown[]
      turnstileToken: string
    }
    expect(body.templateId).toBe(DEFAULT_PROPS.templateId)
    expect(Array.isArray(body.conversation)).toBe(true)
    expect(typeof body.turnstileToken).toBe('string')

    const values = readChatDraftValues(DEFAULT_PROPS.templateId)
    expect(values.content.agenda).toBe('来月の旅行について話した')
    // 振り分け成功時は memo dump 警告を出さない。
    expect(sessionStorage.getItem('minutes:draft-warning')).toBeNull()
  })

  it('extract が meetingDate を返す → chat-draft が { content, meetingDate } 形式で保存され meetingDate を含む', async () => {
    const fetchMock = makeFetchMock({
      ok: true,
      values: { agenda: '来月の旅行について話した' },
      meetingDate: '2026-08-15',
    })
    global.fetch = fetchMock
    await sendOneUserMessage(fetchMock)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '議事録にする' }))
    })
    await waitFor(() => {
      expect(pushMock).toHaveBeenCalled()
    })

    const values = readChatDraftValues(DEFAULT_PROPS.templateId)
    expect(values.content.agenda).toBe('来月の旅行について話した')
    expect(values.meetingDate).toBe('2026-08-15')
  })

  it('extract が meetingDate を返さない → chat-draft の meetingDate は today（YYYY-MM-DD）', async () => {
    const fetchMock = makeFetchMock({ ok: true, values: { agenda: '来月の旅行について話した' } })
    global.fetch = fetchMock
    await sendOneUserMessage(fetchMock)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '議事録にする' }))
    })
    await waitFor(() => {
      expect(pushMock).toHaveBeenCalled()
    })

    const values = readChatDraftValues(DEFAULT_PROPS.templateId)
    // 未指定時は todayIso フォールバック（YYYY-MM-DD 形式であること）。
    expect(values.meetingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('extract-fields が非 200（Turnstile 失敗等）でもクラッシュせず既存 memo dump に落ちる', async () => {
    const fetchMock = makeFetchMock({ ok: false, status: 403 })
    global.fetch = fetchMock
    await sendOneUserMessage(fetchMock)

    const finalizeButton = screen.getByRole('button', { name: '議事録にする' })
    await act(async () => {
      fireEvent.click(finalizeButton)
    })

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith(
        `/minutes/new/adjust?template_id=${DEFAULT_PROPS.templateId}`,
      )
    })
    expect(
      localStorage.getItem(makeFormCacheKey(guestChatDraftFormId(DEFAULT_PROPS.templateId))),
    ).not.toBeNull()
    expect(sessionStorage.getItem('minutes:draft-warning')).not.toBeNull()
  })
})

describe('ChatView — GA5 Turnstile ゲート', () => {
  it('(f) 初回 kick-off 時、Turnstile トークン未到着なら chat/stream fetch が呼ばれない（待機している）', async () => {
    turnstileControls.autoToken = false // token を発火しない
    const fetchMock = makeFetchMock()
    global.fetch = fetchMock

    await act(async () => {
      render(<ChatView {...DEFAULT_PROPS} isGuest />)
    })
    // 100ms 待っても fetch は 0 件（consumeToken() で waiter に留まっている）。
    await new Promise((r) => setTimeout(r, 100))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('(g) onToken 発火後に kick-off fetch が呼ばれ、body.turnstileToken が非空', async () => {
    turnstileControls.autoToken = false
    const fetchMock = makeFetchMock()
    global.fetch = fetchMock

    await act(async () => {
      render(<ChatView {...DEFAULT_PROPS} isGuest />)
    })
    await waitFor(() => {
      expect(turnstileControls.latestOnToken).not.toBeNull()
    })
    expect(fetchMock).not.toHaveBeenCalled()

    // 手動でトークンを配信 → 待機していた consumeToken() が resolve → fetch が走る。
    await act(async () => {
      turnstileControls.latestOnToken!('late-token-abc')
    })
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse((init as RequestInit).body as string) as {
      turnstileToken: string
    }
    expect(body.turnstileToken).toBe('late-token-abc')
  })

  it('(k) 送信成功後に widget.reset が呼ばれる（次回チャレンジ発火・Cloudflare 仕様）', async () => {
    turnstileControls.autoToken = false
    const fetchMock = makeFetchMock() // chat/stream は既定で成功レスポンス
    global.fetch = fetchMock

    await act(async () => {
      render(<ChatView {...DEFAULT_PROPS} isGuest />)
    })
    await waitFor(() => {
      expect(turnstileControls.latestOnToken).not.toBeNull()
    })

    // 1 回目のトークンを配信 → kick-off の fetch が走り、成功して reset が呼ばれる。
    await act(async () => {
      turnstileControls.latestOnToken!('token-1')
    })
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(turnstileControls.resetMock).toHaveBeenCalled()
    })
  })

  it('(h) chat/stream が失敗した場合、TurnstileWidget の reset が呼ばれる', async () => {
    // chat/stream を全部 500 で失敗させる
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        body: null,
        json: vi.fn().mockResolvedValue({}),
      }),
    )
    global.fetch = fetchMock

    await act(async () => {
      render(<ChatView {...DEFAULT_PROPS} isGuest />)
    })
    // kick-off で fetch → 500 → catch → gate.reset() が発火
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(turnstileControls.resetMock).toHaveBeenCalled()
    })
  })
})

describe('ChatView — GA6 guest AI daily limit (429)', () => {
  it('chat/stream が 429 GUEST_AI_DAILY_LIMIT を返すとログイン誘導せず errorMsg を表示', async () => {
    const fetchMock = makeFetchMock({ ok: false, status: 429 }, {
      status: 429,
      body: { error: 'GUEST_AI_DAILY_LIMIT' },
    })
    global.fetch = fetchMock

    await act(async () => {
      render(<ChatView {...DEFAULT_PROPS} isGuest />)
    })
    // 初回 kick-off で fetch 発火 → 429 → errorMsg 表示
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(
        screen.getByText('AI 呼び出しが集中しています。しばらく待ってから再度お試しください。'),
      ).toBeTruthy()
    })
    // ログイン誘導（router.push）は呼ばれない（時間経過で自動復帰する意味論）。
    expect(pushMock).not.toHaveBeenCalled()
    // form-cache 保存は行わない（GA6 で撤去）。
    expect(localStorage.getItem(`form-cache:v1:minutes:new:chat:${DEFAULT_PROPS.templateId}`)).toBeNull()
  })

  it('汎用エラーメッセージが GUEST_AI_DAILY_LIMIT メッセージを上書きしない', async () => {
    const fetchMock = makeFetchMock({ ok: false, status: 429 }, {
      status: 429,
      body: { error: 'GUEST_AI_DAILY_LIMIT' },
    })
    global.fetch = fetchMock

    await act(async () => {
      render(<ChatView {...DEFAULT_PROPS} isGuest />)
    })

    await waitFor(() => {
      expect(
        screen.getByText('AI 呼び出しが集中しています。しばらく待ってから再度お試しください。'),
      ).toBeTruthy()
    })
    // 「返答の取得に失敗しました」の汎用メッセージは出ないこと（catch 節で上書き除外）。
    expect(
      screen.queryByText('返答の取得に失敗しました。少し時間を置いて再度お試しください。'),
    ).toBeNull()
  })
})

describe('ChatView — isGuest=false（既定）の onFinalize は不変', () => {
  it('createMinute を呼び、guest-chat-draft キーは書き込まない', async () => {
    const fetchMock = makeFetchMock()
    global.fetch = fetchMock
    createMinuteMock.mockResolvedValue({ id: 'm-1' })

    await act(async () => {
      render(<ChatView {...DEFAULT_PROPS} isGuest={false} />)
    })
    await waitFor(() => {
      expect(createChatSessionMock).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    const textarea = screen.getByPlaceholderText(/メッセージを入力/)
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'テストメッセージ' } })
    })
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
    })
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '議事録にする' })).not.toBeDisabled()
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '議事録にする' }))
    })

    await waitFor(() => {
      expect(createMinuteMock).toHaveBeenCalledTimes(1)
    })
    expect(
      localStorage.getItem(makeFormCacheKey(guestChatDraftFormId(DEFAULT_PROPS.templateId))),
    ).toBeNull()
    // 回帰確認: ログインユーザー経路では body に turnstileToken フィールドが乗らない。
    for (const [, init] of fetchMock.mock.calls) {
      const parsed = JSON.parse((init as RequestInit).body as string)
      expect(Object.prototype.hasOwnProperty.call(parsed, 'turnstileToken')).toBe(false)
    }
  })
})
