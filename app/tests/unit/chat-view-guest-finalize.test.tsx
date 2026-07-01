/**
 * ChatView — isGuest=true での onFinalize（「議事録にする」）着地先テスト。
 *
 * GA2 でゲスト分岐に createMinute を呼ばないルーティング修正を追加した。
 * extractFieldsFromChat は未認証だと UNAUTHENTICATED で reject される（既存仕様・本ファイルの
 * 対象外）ため、ChatView 側の既存 catch フォールバック（メモ詰め content）を前提に検証する。
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act, waitFor, screen, fireEvent } from '@testing-library/react'

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

vi.mock('@/components/auth/TurnstileWidget', () => ({
  TurnstileWidget: ({ onToken }: { onToken: (t: string) => void }) => {
    onToken('dummy-turnstile-token')
    return null
  },
}))
vi.mock('@/components/usage/limit-modal', () => ({
  LimitModal: () => null,
}))
vi.mock('@/components/chat/renderWithGizirotto', () => ({
  renderWithGizirotto: (text: string) => text,
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
 */
function makeFetchMock(
  extractFieldsResult: { ok: boolean; status?: number; values?: Record<string, string> } = {
    ok: false,
    status: 401,
  },
) {
  return vi.fn().mockImplementation((url: unknown) => {
    if (typeof url === 'string' && url.includes('/api/minutes/chat/extract-fields')) {
      return Promise.resolve({
        ok: extractFieldsResult.ok,
        status: extractFieldsResult.status ?? (extractFieldsResult.ok ? 200 : 401),
        json: vi.fn().mockResolvedValue({ values: extractFieldsResult.values ?? {} }),
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
  sessionStorage.clear()
  // 非ゲスト経路でも initSession が createChatSession を呼ぶため既定の解決値を用意する
  // （ゲスト経路は crypto.randomUUID() を使うため未使用・無害）。
  createChatSessionMock.mockResolvedValue({ id: 'server-session-uuid' })
  extractFieldsFromChatMock.mockRejectedValue(new Error('UNAUTHENTICATED'))
})

afterEach(() => {
  cleanup()
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
  it('createMinute を呼ばず、guest-chat-draft を sessionStorage へ残してゲスト adjust ルートへ遷移する', async () => {
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
    const raw = sessionStorage.getItem(`minutes:guest-chat-draft:${DEFAULT_PROPS.templateId}`)
    expect(raw).not.toBeNull()
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
    const raw = sessionStorage.getItem(`minutes:guest-chat-draft:${DEFAULT_PROPS.templateId}`)
    const content = JSON.parse(raw!) as Record<string, string>
    // extractFieldsFromChat が reject → 既存 catch フォールバックで fields[0] にメモが入る。
    expect(typeof content.agenda).toBe('string')
    expect(content.agenda.length).toBeGreaterThan(0)
  })

  it('GA4: /api/minutes/chat/extract-fields を templateId/conversation 付きで呼び、成功時は values がそのまま content になる', async () => {
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

    const raw = sessionStorage.getItem(`minutes:guest-chat-draft:${DEFAULT_PROPS.templateId}`)
    const content = JSON.parse(raw!) as Record<string, string>
    expect(content.agenda).toBe('来月の旅行について話した')
    // 振り分け成功時は memo dump 警告を出さない。
    expect(sessionStorage.getItem('minutes:draft-warning')).toBeNull()
  })

  it('GA4: extract-fields が非 200（Turnstile 失敗等）でもクラッシュせず既存 memo dump に落ちる', async () => {
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
    const raw = sessionStorage.getItem(`minutes:guest-chat-draft:${DEFAULT_PROPS.templateId}`)
    expect(raw).not.toBeNull()
    expect(sessionStorage.getItem('minutes:draft-warning')).not.toBeNull()
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
      sessionStorage.getItem(`minutes:guest-chat-draft:${DEFAULT_PROPS.templateId}`),
    ).toBeNull()
  })
})
