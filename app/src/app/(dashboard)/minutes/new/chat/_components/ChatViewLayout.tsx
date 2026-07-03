'use client'

import { LimitModal } from '@/components/usage/limit-modal'
import { GizirottoIcon } from '@/components/GizirottoIcon'
import { renderWithGizirotto } from '@/components/chat/renderWithGizirotto'
import { TurnstileWidget } from '@/components/auth/TurnstileWidget'
import type { useGuestTurnstileGate } from '@/hooks/useGuestTurnstileGate'
import type { useChatSession } from '../use-chat-session'
import type { useChatFinalize } from '../use-chat-finalize'
import type { ChatMessage, ChatLimitModalState } from '../ChatView'

interface ChatViewLayoutProps {
  messages: ChatMessage[]
  input: string
  onInputChange: (v: string) => void
  errorMsg: string | null
  session: ReturnType<typeof useChatSession>
  finalize: ReturnType<typeof useChatFinalize>
  limitModal: ChatLimitModalState
  onCloseLimitModal: () => void
  isGuest?: boolean
  turnstileGate: ReturnType<typeof useGuestTurnstileGate>
}

export default function ChatViewLayout({
  messages,
  input,
  onInputChange,
  errorMsg,
  session,
  finalize,
  limitModal,
  onCloseLimitModal,
  isGuest,
  turnstileGate,
}: ChatViewLayoutProps) {
  const visibleMessages = messages
  const canFinalize = !session.streaming && messages.some((m) => m.role === 'user')
  // messages のレンダー直前。会話全体で GIZIROTTO_MAX_TOTAL 個まで、という通し番号を
  // この render 呼び出し内だけで追跡するローカル変数。useState/useRef 化しない — render の
  // たびに 0 から数え直しても、同じ messages 配列なら同じ位置が置換対象になり結果は毎回同じ
  // （副作用を持たない）。
  let gizirottoUsed = 0

  return (
    <div className="flex-1 flex flex-col gap-3 min-h-0">
      <div
        ref={session.scrollRef}
        className="flex-1 bg-white border border-gizirotto-blue-100 rounded p-3 overflow-y-auto min-h-[20rem] max-h-[60vh] space-y-3"
      >
        {visibleMessages.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-8 text-xs text-gray-400">
            <GizirottoIcon size={48} anim="think" />
            <p>会話を準備しています...</p>
          </div>
        )}
        {visibleMessages.map((m, i) => (
          <div
            key={i}
            className={
              m.role === 'user'
                ? 'flex justify-end'
                : 'flex justify-start'
            }
          >
            <div
              className={
                m.role === 'user'
                  ? 'bg-gizirotto-blue-100 text-gizirotto-blue-900 px-3 py-2 rounded-2xl max-w-[80%] whitespace-pre-wrap text-sm'
                  : 'bg-gizirotto-blue-50 text-gray-800 px-3 py-2 rounded-2xl max-w-[80%] whitespace-pre-wrap text-sm'
              }
            >
              {m.role === 'assistant'
                ? m.content
                  ? (() => {
                      const result = renderWithGizirotto(m.content, gizirottoUsed)
                      gizirottoUsed += result.usedInThisText
                      return result.node
                    })()
                  : session.streaming
                    ? <GizirottoIcon size={28} anim="think" />
                    : ''
                : m.content}
            </div>
          </div>
        ))}
      </div>

      {errorMsg && (
        <p className="text-sm text-red-600" role="alert">
          {errorMsg}
        </p>
      )}

      {session.aiSuggestComplete && !finalize.finalizing && (
        <div className="bg-gizirotto-blue-50 border border-gizirotto-blue-200 rounded p-3 text-sm text-gizirotto-blue-900 flex items-center gap-2">
          <GizirottoIcon size={40} anim="pop" className="shrink-0" />
          <span>だいたい揃ったみたいです。議事録にしますか？それとももう少し話しますか？</span>
        </div>
      )}

      <form onSubmit={session.onSend} className="flex items-end gap-2">
        <textarea
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void session.onSend(e as unknown as React.FormEvent)
            }
          }}
          placeholder={session.streaming ? '返答中…' : 'メッセージを入力'}
          disabled={session.streaming || finalize.finalizing}
          rows={2}
          className="flex-1 border border-gizirotto-blue-200 rounded px-3 py-2 text-base min-h-[3rem] resize-none"
        />
        <button
          type="submit"
          disabled={session.streaming || finalize.finalizing || !input.trim()}
          className="bg-gizirotto-blue-700 text-white px-4 py-2 rounded hover:bg-gizirotto-blue-800 disabled:opacity-50"
        >
          送信
        </button>
      </form>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={finalize.onFinalize}
          disabled={!canFinalize || finalize.finalizing}
          className="text-sm text-gizirotto-blue-700 hover:text-gizirotto-blue-900 disabled:text-gray-400"
        >
          {finalize.finalizing ? '準備中…' : '議事録にする'}
        </button>
      </div>

      {/* Invisible Turnstile challenge for unauthenticated visitors.
          Mounted only when isGuest=true and site key is configured.
          Token flows through useGuestTurnstileGate so awaiters (kick-off etc.) get resolved. */}
      {isGuest && (
        <TurnstileWidget
          ref={(w) => turnstileGate.bindWidget(w)}
          onToken={turnstileGate.onToken}
        />
      )}

      {/* AI 上限 / リソース上限の到達モーダル */}
      <LimitModal
        open={limitModal.open}
        scope={limitModal.scope}
        resource={limitModal.resource}
        resetAt={limitModal.resetAt}
        onClose={onCloseLimitModal}
      />
    </div>
  )
}
