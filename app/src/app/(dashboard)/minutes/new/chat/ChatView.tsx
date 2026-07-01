'use client'

import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import {
  createChatSession,
  extractFieldsFromChat,
  persistChatTurn,
} from '@/server/chat-sessions'
import { createMinute } from '@/server/minutes'
import { humanizeErrorCode } from '@/lib/errors/user-message'
import {
  LimitModal,
  type LimitScope,
  type LimitResource,
} from '@/components/usage/limit-modal'
import { ResourceLimitError } from '@/lib/db-error-mapper'
import { GizirottoIcon } from '@/components/GizirottoIcon'
import { renderWithGizirotto } from '@/components/chat/renderWithGizirotto'
import { useFormCache } from '@/lib/hooks/use-form-cache'
import { TurnstileWidget } from '@/components/auth/TurnstileWidget'

export type TemplateField = { name: string; label: string }

interface Props {
  templateId: string
  templateName: string
  mode: 'A-1' | 'A-2'
  fields: TemplateField[]
  /** True when the page was rendered for an unauthenticated visitor. */
  isGuest?: boolean
}

type ChatMessage = { role: 'user' | 'assistant'; content: string }

/** snapshot shape stored by useFormCache for the chat flow */
type ChatSnapshot = {
  messages: ChatMessage[]
  input: string
}

const COMPLETE_TOKEN = '[[CHAT_COMPLETE]]'
/** TTL for guest form snapshots (30 min) — long enough for magic-link login round-trip */
const GUEST_SNAPSHOT_TTL_MS = 30 * 60 * 1000

export function ChatView({ templateId, templateName, mode, fields, isGuest }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [aiSuggestComplete, setAiSuggestComplete] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [finalizing, setFinalizing] = useState(false)
  // Turnstile token for guest requests. Reset after each send to force re-challenge.
  const [turnstileToken, setTurnstileToken] = useState<string>('')
  // 上限到達モーダル状態 (AI route 429 / リソース上限 ResourceLimitError 両対応)
  const [limitModal, setLimitModal] = useState<{
    open: boolean
    scope: LimitScope | null
    resource: LimitResource | null
    resetAt: string | null
  }>({ open: false, scope: null, resource: null, resetAt: null })
  const initRan = useRef(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // form-cache: snapshot は未ログインでログイン後の復帰を想定して 30 分 TTL
  const formId = `minutes:new:chat:${templateId}`
  const { saveSnapshot, clearSnapshot } = useFormCache<ChatSnapshot>(formId, {
    ttlMs: GUEST_SNAPSHOT_TTL_MS,
    onRestore: (v) => {
      setMessages(v.messages)
      setInput(v.input)
    },
  })

  // 初回マウントで chat_sessions 作成 + 最初の assistant 質問を取得
  useEffect(() => {
    if (initRan.current) return
    initRan.current = true
    void initSession()
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

    // Capture and reset the token before the fetch so a re-challenge starts
    // immediately; token is single-use and must not be reused on retry.
    const capturedToken = turnstileToken
    if (isGuest) setTurnstileToken('')

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
          ...(isGuest ? { turnstileToken: capturedToken } : {}),
        }),
      })
      // 429 AI_LIMIT_EXCEEDED は modal で出し分け
      if (res.status === 429) {
        try {
          const body = (await res.json()) as {
            code?: string
            scope?: LimitScope
            reset_at?: string
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
      // 401 AI_LIMIT_GUEST: guest trial exhausted → save snapshot → redirect to login
      if (res.status === 401) {
        try {
          const body = (await res.json()) as { error?: string; loginUrl?: string }
          if (body.error === 'AI_LIMIT_GUEST') {
            // Persist conversation so it can be restored after login
            saveSnapshot({ messages, input })
            const next = body.loginUrl ?? `/login?next=${encodeURIComponent(pathname ?? '/')}`
            router.push(next)
            return
          }
        } catch {
          // fallthrough to generic error
        }
      }
      if (!res.ok || !res.body) throw new Error('STREAM_FAILED')

      // 空の assistant メッセージを追加して逐次更新
      setMessages((prev) => [...prev, { role: 'assistant', content: '' }])

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const blocks = buffer.split('\n\n')
        buffer = blocks.pop() ?? ''
        for (const block of blocks) {
          const line = block.startsWith('data: ') ? block.slice(6) : block
          if (!line.trim()) continue
          try {
            const evt = JSON.parse(line)
            if (evt.type === 'delta' && typeof evt.text === 'string') {
              assistantText += evt.text
              setMessages((prev) => {
                const next = [...prev]
                next[next.length - 1] = {
                  role: 'assistant',
                  content: stripCompleteToken(assistantText),
                }
                return next
              })
            } else if (evt.type === 'error') {
              throw new Error(evt.message ?? 'stream_error')
            }
          } catch {
            // 部分受信エラーは次フレームで回復
          }
        }
      }

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
    } catch {
      setErrorMsg('返答の取得に失敗しました。少し時間を置いて再度お試しください。')
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

  async function onFinalize() {
    setFinalizing(true)
    setErrorMsg(null)

    // AI で会話履歴を各 field に項目別バインドする。
    // 失敗時 fallback = 最初の field に memo 詰め + 確認画面に警告表示。
    let content: Record<string, string>
    let extractFailed = false
    const memo = messages
      .map((m) => `[${m.role === 'user' ? 'ユーザー' : 'AI'}] ${m.content}`)
      .join('\n')
    if (fields.length === 0) {
      // テンプレ field 抽出に失敗（旧形式テンプレ等）で fields=[] になったときの fallback。
      // extractFieldsFromChat の zod は .min(1) で空を弾くため事前に fallback に倒す。
      extractFailed = true
      content = { '(振り分け不可)': memo }
    } else {
      try {
        // ログインユーザーは既存 Server Action のまま。ゲストは Server Action 内の
        // `if (!user) throw` に必ず引っかかるため、代わりにゲスト専用 route を叩く。
        // Turnstile トークンは sendMessage と同じ「直前にキャプチャして即リセット」使い捨て
        // パターン。直前の送信で既に消費済みのことが多く、その場合 guestAiGate が
        // TURNSTILE_FAILED を返すが、それは想定内 — 下の catch がそのまま
        // memo dump fallback に合流させるので新しいエラーハンドリングは不要。
        let result: { values: Record<string, string> }
        if (isGuest) {
          const capturedToken = turnstileToken
          setTurnstileToken('')
          const res = await fetch('/api/minutes/chat/extract-fields', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              templateId,
              conversation: messages,
              turnstileToken: capturedToken,
            }),
          })
          if (!res.ok) throw new Error('EXTRACT_FIELDS_FAILED')
          result = (await res.json()) as { values: Record<string, string> }
        } else {
          result = await extractFieldsFromChat({
            fields,
            conversation: messages,
          })
        }
        const hasAnyValue = Object.values(result.values).some(
          (v) => typeof v === 'string' && v.trim().length > 0,
        )
        if (!hasAnyValue) {
          // extract が空 values を返した場合も confirm 画面の空表示を防ぐため fallback に倒す。
          extractFailed = true
          content = {}
          for (const f of fields) content[f.name] = ''
          if (fields.length > 0) content[fields[0].name] = memo
          else content['(振り分け不可)'] = memo
        } else {
          content = result.values
        }
      } catch {
        extractFailed = true
        content = {}
        for (const f of fields) content[f.name] = ''
        if (fields.length > 0) content[fields[0].name] = memo
      }
    }

    // content が完全空でもサーバ refine で reject されるため、
    // 空ならチャット履歴 memo を確実に 1 キー詰める。
    if (Object.keys(content).length === 0) {
      content = { 'メモ': memo || '(会話履歴なし)' }
      extractFailed = true
    }

    // sessionStorage 経由の draft 持ち回りを廃止し、ここで createMinute を 1 回実行 →
    // そのまま AdjustView へ遷移する。
    // 振り分け失敗 warning は sessionStorage に残し、AdjustView 初回マウントで toast 化。
    const title = `${templateName} ${new Date().toLocaleDateString('ja-JP')}`
    const meetingDate = todayIso()
    if (extractFailed) {
      sessionStorage.setItem(
        'minutes:draft-warning',
        'うまく振り分けられませんでした。編集画面で手動で編集してください。',
      )
    } else {
      sessionStorage.removeItem('minutes:draft-warning')
    }

    // ゲストは minute レコードを持てない。抽出済み content を一度きりの sessionStorage キーで
    // ゲスト向け AdjustView 到達ルートへ渡し、そのまま遷移する（createMinute は呼ばない）。
    if (isGuest) {
      try {
        sessionStorage.setItem(
          `minutes:guest-chat-draft:${templateId}`,
          JSON.stringify(content),
        )
      } catch {
        // 書き込み失敗は致命でない（AdjustView 側は空初期値にフォールバックする）。
      }
      clearSnapshot()
      router.push(`/minutes/new/adjust?template_id=${templateId}`)
      return
    }

    try {
      const result = await createMinute({
        templateId,
        title,
        meetingDate,
        content,
        sourceMode: mode,
      })
      // Clear snapshot on successful save
      clearSnapshot()
      router.push(`/minutes/${result.id}/adjust`)
    } catch (e) {
      // 失敗時は遷移しない（ChatView に留まる）。
      // 議事録月次上限 (ResourceLimitError) → LimitModal
      // Server Action のシリアライズで instanceof が外れる場合に備え name + message で判定。
      if (isResourceLimitError(e, 'minutes')) {
        setLimitModal({
          open: true,
          scope: null,
          resource: 'minutes',
          resetAt: null,
        })
        sessionStorage.removeItem('minutes:draft-warning')
        setFinalizing(false)
        return
      }
      const isEmpty =
        e instanceof Error && /EMPTY_CONTENT|empty_content/i.test(e.message)
      setErrorMsg(
        e instanceof Error && e.message === 'NOT_IN_FAMILY'
          ? '家族の設定が反映されていません。少し時間を置いて再度お試しください。'
          : isEmpty
            ? 'まだ何も入っていないみたいです。もう少し会話してから議事録にしてください。'
            : `保存に失敗しました: ${humanizeErrorCode(e instanceof Error ? e.message : null).message}`,
      )
      sessionStorage.removeItem('minutes:draft-warning')
      setFinalizing(false)
    }
  }

  const visibleMessages = messages
  const canFinalize = !streaming && messages.some((m) => m.role === 'user')

  return (
    <div className="flex-1 flex flex-col gap-3 min-h-0">
      <div
        ref={scrollRef}
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
                  ? renderWithGizirotto(m.content)
                  : streaming
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

      {aiSuggestComplete && !finalizing && (
        <div className="bg-gizirotto-blue-50 border border-gizirotto-blue-200 rounded p-3 text-sm text-gizirotto-blue-900 flex items-center gap-2">
          <GizirottoIcon size={40} anim="pop" className="shrink-0" />
          <span>だいたい揃ったみたいです。議事録にしますか？それとももう少し話しますか？</span>
        </div>
      )}

      <form onSubmit={onSend} className="flex items-end gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void onSend(e as unknown as React.FormEvent)
            }
          }}
          placeholder={streaming ? '返答中…' : 'メッセージを入力'}
          disabled={streaming || finalizing}
          rows={2}
          className="flex-1 border border-gizirotto-blue-200 rounded px-3 py-2 text-base min-h-[3rem] resize-none"
        />
        <button
          type="submit"
          disabled={streaming || finalizing || !input.trim()}
          className="bg-gizirotto-blue-700 text-white px-4 py-2 rounded hover:bg-gizirotto-blue-800 disabled:opacity-50"
        >
          送信
        </button>
      </form>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={onFinalize}
          disabled={!canFinalize || finalizing}
          className="text-sm text-gizirotto-blue-700 hover:text-gizirotto-blue-900 disabled:text-gray-400"
        >
          {finalizing ? '準備中…' : '議事録にする'}
        </button>
      </div>

      {/* Invisible Turnstile challenge for unauthenticated visitors.
          Mounted only when isGuest=true and site key is configured.
          Token is reset after each send so each request gets a fresh challenge. */}
      {isGuest && <TurnstileWidget onToken={setTurnstileToken} />}

      {/* AI 上限 / リソース上限の到達モーダル */}
      <LimitModal
        open={limitModal.open}
        scope={limitModal.scope}
        resource={limitModal.resource}
        resetAt={limitModal.resetAt}
        onClose={() =>
          setLimitModal({
            open: false,
            scope: null,
            resource: null,
            resetAt: null,
          })
        }
      />
    </div>
  )
}

/**
 * Server Action のシリアライズ仕様により、custom Error クラスの prototype は
 * クライアント側で失われる場合がある (instanceof が常に true とは限らない)。
 * ResourceLimitError は name='ResourceLimitError' + message='RESOURCE_LIMIT_EXCEEDED' を
 * 持つ sentinel として判定する。さらに instanceof チェックも併用 (両対応・冗長判定)。
 */
function isResourceLimitError(
  e: unknown,
  resource: 'minutes' | 'templates',
): boolean {
  if (e instanceof ResourceLimitError) {
    return e.resource === resource
  }
  if (e instanceof Error) {
    const maybe = e as Error & { resource?: unknown }
    if (
      e.name === 'ResourceLimitError' &&
      e.message === 'RESOURCE_LIMIT_EXCEEDED' &&
      maybe.resource === resource
    ) {
      return true
    }
  }
  return false
}

function stripCompleteToken(text: string): string {
  return text.replaceAll(COMPLETE_TOKEN, '').trimEnd()
}

function todayIso(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
