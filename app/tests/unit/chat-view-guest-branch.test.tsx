/**
 * ChatView guest branch unit tests.
 *
 * Verifies that:
 *   - createChatSession is NOT called when isGuest=true
 *   - persistChatTurn is NOT called when isGuest=true (even after a normal send)
 *   - persistChatTurn is NOT called when isGuest=true after a user message send
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act, waitFor, screen, fireEvent } from '@testing-library/react'

// --- mock next/navigation ---
const pushMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/minutes/new/chat?templateId=00000000-0000-0000-0000-000000000001',
}))

// --- mock Server Actions ---
const createChatSessionMock = vi.fn()
const persistChatTurnMock = vi.fn()
const extractFieldsFromChatMock = vi.fn()
vi.mock('@/server/chat-sessions', () => ({
  createChatSession: (...args: unknown[]) => createChatSessionMock(...args),
  persistChatTurn: (...args: unknown[]) => persistChatTurnMock(...args),
  extractFieldsFromChat: (...args: unknown[]) => extractFieldsFromChatMock(...args),
}))
vi.mock('@/server/minutes', () => ({
  createMinute: vi.fn(),
}))

// --- mock TurnstileWidget (renders nothing) ---
vi.mock('@/components/auth/TurnstileWidget', () => ({
  TurnstileWidget: ({ onToken }: { onToken: (t: string) => void }) => {
    // Immediately provide a dummy token so ChatView can proceed
    onToken('dummy-turnstile-token')
    return null
  },
}))

// --- mock LimitModal ---
vi.mock('@/components/usage/limit-modal', () => ({
  LimitModal: () => null,
  ResourceLimitError: class ResourceLimitError extends Error {
    constructor() { super('RESOURCE_LIMIT_EXCEEDED') }
  },
}))

// --- mock renderWithGizirotto (GA7: returns {node, usedInThisText} shape) ---
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
    constructor() { super('RESOURCE_LIMIT_EXCEEDED') }
  },
}))

// SSE stream helper: returns a minimal SSE stream with one done event
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

function makeFetchMock(status = 200) {
  // Each call gets a fresh SSE stream — a ReadableStream can only be consumed once.
  return vi.fn().mockImplementation(() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      body: makeSseStream(),
      json: vi.fn().mockResolvedValue({}),
    }),
  )
}

// jsdom does not implement scrollTo; patch it so ChatView's useEffect does not throw.
window.HTMLElement.prototype.scrollTo = vi.fn()

// -----------------------------------------------------------------------

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
  pushMock.mockReset()
  // Default: createChatSession returns a session id (used only for non-guest)
  createChatSessionMock.mockResolvedValue({ id: 'server-session-uuid' })
  // crypto.randomUUID must exist in jsdom (available via globalThis in modern jsdom)
})

afterEach(() => {
  cleanup()
})

describe('ChatView — isGuest=true', () => {
  it('createChatSession が呼ばれない（ゲスト UUID はクライアント生成）', async () => {
    const fetchMock = makeFetchMock()
    global.fetch = fetchMock

    await act(async () => {
      render(<ChatView {...DEFAULT_PROPS} isGuest />)
    })

    // Wait for initSession to complete (fetch is called for the kick message)
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled()
    })

    expect(createChatSessionMock).not.toHaveBeenCalled()
  })

  it('persistChatTurn が呼ばれない（kick ターン後）', async () => {
    const fetchMock = makeFetchMock()
    global.fetch = fetchMock

    await act(async () => {
      render(<ChatView {...DEFAULT_PROPS} isGuest />)
    })

    // Wait for initSession kick fetch
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled()
    })

    expect(persistChatTurnMock).not.toHaveBeenCalled()
  })

  it('persistChatTurn が呼ばれない（user メッセージ送信後）', async () => {
    const fetchMock = makeFetchMock()
    global.fetch = fetchMock

    await act(async () => {
      render(<ChatView {...DEFAULT_PROPS} isGuest />)
    })

    // Wait for kick fetch to complete
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    // Type a user message and submit via Ctrl+Enter
    const textarea = screen.getByPlaceholderText(/メッセージを入力/)
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'テストメッセージ' } })
    })
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
    })

    // Wait for the second fetch (user message send)
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    // persistChatTurn must never be called for guests regardless of message count
    expect(persistChatTurnMock).not.toHaveBeenCalled()
  })
})

describe('ChatView — isGuest=false (non-guest baseline)', () => {
  it('createChatSession が呼ばれる', async () => {
    const fetchMock = makeFetchMock()
    global.fetch = fetchMock

    await act(async () => {
      render(<ChatView {...DEFAULT_PROPS} isGuest={false} />)
    })

    await waitFor(() => {
      expect(createChatSessionMock).toHaveBeenCalledWith({
        templateId: DEFAULT_PROPS.templateId,
        mode: DEFAULT_PROPS.mode,
      })
    })
  })
})
