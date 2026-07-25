'use client'

import { useState } from 'react'
import {
  type LimitScope,
  type LimitResource,
} from '@/components/usage/limit-modal'
import { useFormCache } from '@/lib/hooks/use-form-cache'
import { GUEST_SNAPSHOT_TTL_MS } from '@/lib/utils/form-cache'
import { useGuestTurnstileGate } from '@/hooks/useGuestTurnstileGate'
import { useChatSession } from './use-chat-session'
import { useChatFinalize } from './use-chat-finalize'
import ChatViewLayout from './_components/ChatViewLayout'

export type TemplateField = { name: string; label: string }

interface Props {
  templateId: string
  templateName: string
  mode: 'A-1' | 'A-2'
  fields: TemplateField[]
  /** True when the page was rendered for an unauthenticated visitor. */
  isGuest?: boolean
  /** True when the user is logged in but has not joined/created a family yet. */
  needsFamilySetup?: boolean
}

export type ChatMessage = { role: 'user' | 'assistant'; content: string }

/** snapshot shape stored by useFormCache for the chat flow */
type ChatSnapshot = {
  messages: ChatMessage[]
  input: string
}

/** ChatView 上限到達モーダル state（AI route 429 / リソース上限 ResourceLimitError 両対応）。 */
export type ChatLimitModalState = {
  open: boolean
  scope: LimitScope | null
  resource: LimitResource | null
  resetAt: string | null
}

export function ChatView({
  templateId,
  templateName,
  mode,
  fields,
  isGuest,
  needsFamilySetup,
}: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  // Guest Turnstile ゲート: 送信直前に await consumeToken() で到着待機（初回 kick-off が
  // widget mount より先に走る race を吸収）。ログイン済み時は enabled=false で undefined
  // 即 return するのでログインユーザー経路は完全不変。
  const turnstileGate = useGuestTurnstileGate(isGuest ?? false)
  // 上限到達モーダル状態 (AI route 429 / リソース上限 ResourceLimitError 両対応)
  const [limitModal, setLimitModal] = useState<ChatLimitModalState>({
    open: false,
    scope: null,
    resource: null,
    resetAt: null,
  })

  // form-cache: 議事録化成功時に snapshot をクリアする用途のみで使う（saveSnapshot 経路は撤去済み）。
  // onRestore は別セッションから戻ってきた時の会話復元用に温存（将来の form-cache 拡張時に活用）。
  const formId = `minutes:new:chat:${templateId}`
  const { clearSnapshot } = useFormCache<ChatSnapshot>(formId, {
    ttlMs: GUEST_SNAPSHOT_TTL_MS,
    onRestore: (v) => {
      setMessages(v.messages)
      setInput(v.input)
    },
  })

  // 初回 init / scroll / 送信ストリーミング（sendMessage・onSend）を束ねる hook。
  const session = useChatSession({
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
  })

  // 議事録化（onFinalize）を束ねる hook。
  const finalize = useChatFinalize({
    templateId,
    templateName,
    mode,
    fields,
    isGuest,
    needsFamilySetup,
    messages,
    turnstileGate,
    clearSnapshot,
    setErrorMsg,
    setLimitModal,
  })

  return (
    <ChatViewLayout
      messages={messages}
      input={input}
      onInputChange={setInput}
      errorMsg={errorMsg}
      session={session}
      finalize={finalize}
      limitModal={limitModal}
      onCloseLimitModal={() =>
        setLimitModal({ open: false, scope: null, resource: null, resetAt: null })
      }
      isGuest={isGuest}
      turnstileGate={turnstileGate}
    />
  )
}
