'use client'

/**
 * ChatView の初回 init / スクロール追従 / 送信ストリーミング（sendMessage・onSend）を
 * 束ねる custom hook。
 *
 * messages/input/errorMsg/limitModal は sendMessage・onFinalize（use-chat-finalize）・
 * Presenter の三者が触る共有 state のため Container 本体が保持し、本 hook へは値+setter を注入する。
 */
import { useEffect, useRef, useState } from 'react'
import {
  createChatSession,
  persistChatTurn,
} from '@/server/chat-sessions'
import type { UseGuestTurnstileGate } from '@/hooks/useGuestTurnstileGate'
import { type LimitScope } from '@/components/usage/limit-modal'
import { parseSseStream } from '@/lib/utils/sse-stream'
import type { ChatMessage, ChatLimitModalState } from './ChatView'

const COMPLETE_TOKEN = '[[CHAT_COMPLETE]]'

function stripCompleteToken(text: string): string {
  return text.replaceAll(COMPLETE_TOKEN, '').trimEnd()
}

export interface UseChatSessionParams {
  templateId: string
  mode: 'A-1' | 'A-2'
  isGuest?: boolean
  messages: ChatMessage[]
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>
  input: string
  setInput: (v: string) => void
  setErrorMsg: (v: string | null) => void
  setLimitModal: React.Dispatch<React.SetStateAction<ChatLimitModalState>>
  turnstileGate: UseGuestTurnstileGate
}

export interface UseChatSessionReturn {
  streaming: boolean
  aiSuggestComplete: boolean
  scrollRef: React.RefObject<HTMLDivElement | null>
  onSend: (e: React.FormEvent) => Promise<void>
}

export function useChatSession({
  templateId,
  mode,
  isGuest,
  messages,
  setMessages,
  input,
  setInput,
  setErrorMsg,
  setLimitModal,
  turnstileGate,
}: UseChatSessionParams): UseChatSessionReturn {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [streaming, setStreaming] = useState(false)
  const [aiSuggestComplete, setAiSuggestComplete] = useState(false)
  const initRan = useRef(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // 初回マウントで chat_sessions 作成 + 最初の assistant 質問を取得
  useEffect(() => {
    if (initRan.current) return
    initRan.current = true
    void initSession()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, streaming])

  async function initSession() {
    try {
      // Guests get a client-generated UUID as a session ID so chat/stream can route
      // the conversation without persisting a chat_sessions row in the database.
      const id = isGuest
        ? crypto.randomUUID()
        : (await createChatSession({ templateId, mode })).id
      setSessionId(id)
      // 最初の assistant 発言を取りに行く（user メッセージは空のキック）
      await sendMessage('（はじめてください）', id, [])
    } catch {
      setErrorMsg('チャットを開始できませんでした。少し時間を置いて再度お試しください。')
    }
  }

  async function onSend(e: React.FormEvent) {
    e.preventDefault()
    if (streaming || !input.trim() || !sessionId) return
    const userMessage = input.trim()
    setInput('')
    await sendMessage(userMessage, sessionId, messages)
  }

  async function sendMessage(
    userMessage: string,
    sid: string,
    history: ChatMessage[],
  ) {
    setStreaming(true)
    setErrorMsg(null)
    // user メッセージを即時 push（初回 kick の "（はじめてください）" は隠す）
    const isKick = history.length === 0
    if (!isKick) {
      setMessages((prev) => [...prev, { role: 'user', content: userMessage }])
    }

    // Await token arrival. If enabled=false (logged-in), resolves undefined immediately
    // and the ...spread below omits the field entirely — so logged-in bodies remain unchanged.
    // For guests, this waits until TurnstileWidget's onVerify has delivered a token, fixing
    // the initial kick-off race where the effect fired before challenge completion.
    const capturedToken = await turnstileGate.consumeToken()

    let assistantText = ''
    try {
      const res = await fetch('/api/minutes/chat/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          session_id: sid,
          mode,
          template_id: templateId,
          history,
          latest_user_message: userMessage,
          ...(capturedToken !== undefined ? { turnstileToken: capturedToken } : {}),
        }),
      })
      // 429 の 2 分岐: (a) ゲスト AI 濫用防御（GUEST_AI_DAILY_LIMIT・時間経過で自動復帰）、
      // (b) ログインユーザーの月次上限（AI_LIMIT_EXCEEDED・LimitModal で出し分け）。
      // ゲスト経路ではログイン誘導ではなく通常のエラーメッセージにして、時間を置けば復帰できる
      // ことを伝える（「議事録 2 件制限」は guestTemplateLimit で別途担保しているため、AI 濫用
      // 防御到達時にログインを強制しない）。
      if (res.status === 429) {
        try {
          const body = (await res.json()) as {
            error?: string
            code?: string
            scope?: LimitScope
            reset_at?: string
          }
          if (body.error === 'GUEST_AI_DAILY_LIMIT') {
            setErrorMsg('AI 呼び出しが集中しています。しばらく待ってから再度お試しください。')
            throw new Error('GUEST_AI_DAILY_LIMIT')
          }
          if (body.code === 'AI_LIMIT_EXCEEDED' && body.scope) {
            setLimitModal({
              open: true,
              scope: body.scope,
              resource: null,
              resetAt: body.reset_at ?? null,
            })
          }
        } catch {
          // JSON 解析失敗時は通常エラーフローに倒す
        }
        throw new Error('AI_LIMIT_EXCEEDED')
      }
      if (!res.ok || !res.body) throw new Error('STREAM_FAILED')

      // 空の assistant メッセージを追加して逐次更新
      setMessages((prev) => [...prev, { role: 'assistant', content: '' }])

      await parseSseStream(res.body, (text) => {
        assistantText += text
        setMessages((prev) => {
          const next = [...prev]
          next[next.length - 1] = {
            role: 'assistant',
            content: stripCompleteToken(assistantText),
          }
          return next
        })
      })

      // 完了トークン検知 → AI 提案の完了状態に
      const aiComplete = assistantText.includes(COMPLETE_TOKEN)
      if (aiComplete) setAiSuggestComplete(true)

      // DB persist（kick は user メッセージを保存しない: スキーマ min(1) violation 回避）
      // Guest conversations are ephemeral — no DB row is created.
      if (!isKick && !isGuest) {
        try {
          await persistChatTurn({
            sessionId: sid,
            userMessage,
            assistantMessage: stripCompleteToken(assistantText) || '(空)',
          })
        } catch {
          // 永続化失敗はサイレント、UX 阻害しない（チャット継続優先）
        }
      }
      // 成功時: 使い切ったトークンをリセットし、次回送信に備えて新チャレンジを発火する。
      // Cloudflare Turnstile invisible の仕様上、明示 reset を呼ばないと次のトークンが
      // 発火されず、2 回目以降の consumeToken() が永久待機になる。enabled=false / widget
      // 未 mount 時は no-op なのでログインユーザー経路は完全不変。
      if (isGuest) turnstileGate.reset()
    } catch (e) {
      // GUEST_AI_DAILY_LIMIT / AI_LIMIT_EXCEEDED は 429 分岐内で既に setErrorMsg / setLimitModal
      // 済み。汎用エラーメッセージで上書きしない。それ以外は「返答の取得に失敗」を表示。
      const isKnownLimit =
        e instanceof Error &&
        (e.message === 'GUEST_AI_DAILY_LIMIT' || e.message === 'AI_LIMIT_EXCEEDED')
      if (!isKnownLimit) {
        setErrorMsg('返答の取得に失敗しました。少し時間を置いて再度お試しください。')
      }
      // Turnstile トークンは使い切ったので次回チャレンジを明示発火。
      // enabled=false / widget 未 mount 時は no-op。
      turnstileGate.reset()
      // 失敗したターンの空 assistant 行を削除
      setMessages((prev) => {
        if (prev.length > 0 && prev[prev.length - 1].role === 'assistant' && prev[prev.length - 1].content === '') {
          return prev.slice(0, -1)
        }
        return prev
      })
    } finally {
      setStreaming(false)
    }
  }

  return { streaming, aiSuggestComplete, scrollRef, onSend }
}
