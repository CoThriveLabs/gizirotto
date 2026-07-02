/**
 * ChatView — GA7 問題1: renderWithGizirotto の「会話全体で合計 GIZIROTTO_MAX_TOTAL 個まで」を
 * 実際の ChatView レンダリング経路で検証する統合テスト。renderWithGizirotto / GizirottoIcon は
 * モックせず実装のまま使う（DOM 上の <img alt="ぎじろっと"> 個数を直接数える）。
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act, waitFor, screen, fireEvent } from '@testing-library/react'

const pushMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}))

const createChatSessionMock = vi.fn()
const persistChatTurnMock = vi.fn()
vi.mock('@/server/chat-sessions', () => ({
  createChatSession: (...args: unknown[]) => createChatSessionMock(...args),
  persistChatTurn: (...args: unknown[]) => persistChatTurnMock(...args),
  extractFieldsFromChat: vi.fn(),
}))
vi.mock('@/server/minutes', () => ({
  createMinute: vi.fn(),
}))
vi.mock('@/components/usage/limit-modal', () => ({
  LimitModal: () => null,
}))
vi.mock('@/lib/db-error-mapper', () => ({
  ResourceLimitError: class ResourceLimitError extends Error {
    resource = 'minutes'
    constructor() {
      super('RESOURCE_LIMIT_EXCEEDED')
    }
  },
}))

window.HTMLElement.prototype.scrollTo = vi.fn()

import { ChatView } from '@/app/(dashboard)/minutes/new/chat/ChatView'

function makeAssistantSseStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const events = [
    `data: ${JSON.stringify({ type: 'delta', text })}\n\n`,
    'data: {"type":"done"}\n\n',
  ]
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

/** 呼び出し順に assistantTexts を 1 つずつ消費する fetch mock（尽きたら最後の値を使い回す）。 */
function makeFetchMock(assistantTexts: string[]) {
  let call = 0
  return vi.fn().mockImplementation(() => {
    const text = assistantTexts[Math.min(call, assistantTexts.length - 1)]
    call += 1
    return Promise.resolve({
      ok: true,
      status: 200,
      body: makeAssistantSseStream(text),
      json: vi.fn().mockResolvedValue({}),
    })
  })
}

const DEFAULT_PROPS = {
  templateId: '00000000-0000-0000-0000-000000000001',
  templateName: 'テスト',
  mode: 'A-1' as const,
  fields: [{ name: 'agenda', label: '議題' }],
}

beforeEach(() => {
  createChatSessionMock.mockReset()
  persistChatTurnMock.mockReset()
  pushMock.mockReset()
  createChatSessionMock.mockResolvedValue({ id: 'server-session-uuid' })
})

afterEach(() => {
  cleanup()
})

function countIcons(): number {
  return document.querySelectorAll('img[alt="ぎじろっと"]').length
}

/**
 * turn 完了待ち。textarea の disabled は `streaming || finalizing` のみに依存し、kick
 * ターン（ユーザーメッセージを伴わない = canFinalize は false のまま）でも一貫して使える
 * 「turn 完了」シグナル。「議事録にする」ボタン（canFinalize 依存）は kick 単体では有効化
 * されないため使わない。
 */
async function waitForTurnComplete(fetchMock: ReturnType<typeof makeFetchMock>, times: number) {
  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledTimes(times)
  })
  await waitFor(() => {
    expect(screen.getByPlaceholderText(/メッセージを入力/)).not.toBeDisabled()
  })
}

describe('ChatView — GA7 問題1: gizirotto 会話全体合計置換', () => {
  it('複数 AI メッセージそれぞれに笑顔絵文字がある会話で、合計置換数が 2 個を超えない', async () => {
    // kick 応答 + 2 回のユーザー送信応答、それぞれに笑顔絵文字を複数含める（合計 6 個投入）。
    const fetchMock = makeFetchMock(['😀了解しました😊', '😍いいですね😎', '☺️承知しました🥰'])
    global.fetch = fetchMock

    await act(async () => {
      render(<ChatView {...DEFAULT_PROPS} isGuest={false} />)
    })
    await waitForTurnComplete(fetchMock, 1)

    const textarea = screen.getByPlaceholderText(/メッセージを入力/)
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'メッセージ1' } })
    })
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
    })
    await waitForTurnComplete(fetchMock, 2)

    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'メッセージ2' } })
    })
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
    })
    await waitForTurnComplete(fetchMock, 3)

    // 3 メッセージ合計で絵文字は 6 個投入されているが、置換上限（GIZIROTTO_MAX_TOTAL=2）を
    // 超えて GizirottoIcon が描画されないことを確認する。
    expect(countIcons()).toBeLessThanOrEqual(2)
    // 実際にちょうど 2 個は置換されている（全く置換されない状態ではないこと）ことも確認。
    expect(countIcons()).toBe(2)
  })

  it('1 メッセージのみで絵文字 1 個の場合は 1 個置換される（回帰・上限未到達時は通常通り）', async () => {
    const fetchMock = makeFetchMock(['😀こんにちは'])
    global.fetch = fetchMock

    await act(async () => {
      render(<ChatView {...DEFAULT_PROPS} isGuest={false} />)
    })
    await waitForTurnComplete(fetchMock, 1)

    expect(countIcons()).toBe(1)
  })
})
