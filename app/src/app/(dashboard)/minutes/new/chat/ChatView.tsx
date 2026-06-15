'use client'

import { useRouter } from 'next/navigation'
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

export type TemplateField = { name: string; label: string }

interface Props {
  templateId: string
  templateName: string
  mode: 'A-1' | 'A-2'
  fields: TemplateField[]
}

type ChatMessage = { role: 'user' | 'assistant'; content: string }

const COMPLETE_TOKEN = '[[CHAT_COMPLETE]]'

export function ChatView({ templateId, templateName, mode, fields }: Props) {
  const router = useRouter()
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [aiSuggestComplete, setAiSuggestComplete] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [finalizing, setFinalizing] = useState(false)
  // 上限到達モーダル状態 (AI route 429 / リソース上限 ResourceLimitError 両対応)
  const [limitModal, setLimitModal] = useState<{
    open: boolean
    scope: LimitScope | null
    resource: LimitResource | null
    resetAt: string | null
  }>({ open: false, scope: null, resource: null, resetAt: null })
  const initRan = useRef(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)

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
      const result = await createChatSession({ templateId, mode })
      setSessionId(result.id)
      // 最初の assistant 発言を取りに行く（user メッセージは空のキック）
      await sendMessage('（はじめてください）', result.id, [])
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
      if (!isKick) {
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

    // §1-3 補強パッチ (spec §6-5 v1.2 前倒し): AI で会話履歴を各 field に項目別バインド。
    // 失敗時 fallback = 最初の field に memo 詰め + 確認画面に警告表示。
    let content: Record<string, string>
    let extractFailed = false
    const memo = messages
      .map((m) => `[${m.role === 'user' ? 'ユーザー' : 'AI'}] ${m.content}`)
      .join('\n')
    if (fields.length === 0) {
      // B-6 防御層: テンプレ field 抽出に失敗 (旧形式 ARRAY 残テンプレ等) で fields=[] のケース。
      // extractFieldsFromChat の zod は .min(1) で空を弾くため事前に fallback に倒す。
      extractFailed = true
      content = { '(振り分け不可)': memo }
    } else {
      try {
        const result = await extractFieldsFromChat({
          fields,
          conversation: messages,
        })
        const hasAnyValue = Object.values(result.values).some(
          (v) => typeof v === 'string' && v.trim().length > 0,
        )
        if (!hasAnyValue) {
          // B-6: extract が空 values を返した場合 (空 fields 早期 return 含む) も
          // confirm 画面の空表示を防ぐため fallback に倒す。
          extractFailed = true
          content = {}
          for (const f of fields) content[f.name] = ''
          if (fields.length > 0) content[fields[0].name] = memo
          else content['(振り分け不可)'] = memo
        } else {
          content = result.values
        }
      } catch (e) {
        // 一時診断ログ（B-6 真因切分用、原因特定後に削除予定）
        // eslint-disable-next-line no-console
        console.error('[ChatView.onFinalize] extractFieldsFromChat failed', e)
        extractFailed = true
        content = {}
        for (const f of fields) content[f.name] = ''
        if (fields.length > 0) content[fields[0].name] = memo
      }
    }

    // N-1 最終ガード: content が完全空でもサーバ refine で reject されるため、
    // ここで空ならチャット履歴 memo を確実に 1 キー詰める。
    if (Object.keys(content).length === 0) {
      content = { 'メモ': memo || '(会話履歴なし)' }
      extractFailed = true
    }

    // N-1 診断ログ（実機 dev 確認用）
    // eslint-disable-next-line no-console
    console.info('[ChatView.onFinalize] draft content', {
      mode,
      fieldsCount: fields.length,
      messagesCount: messages.length,
      extractFailed,
      contentKeys: Object.keys(content),
      contentValueLengths: Object.fromEntries(
        Object.entries(content).map(([k, v]) => [k, (v ?? '').length]),
      ),
    })

    // 案A（ConfirmView 廃止・2026-06-10 設計書）:
    // 旧 sessionStorage 経由の draft 持ち回り + ConfirmView 経由を廃止し、
    // ここで createMinute を 1 回だけ実行 → そのまま AdjustView へ遷移する。
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
    try {
      const result = await createMinute({
        templateId,
        title,
        meetingDate,
        content,
        sourceMode: mode,
      })
      router.push(`/minutes/${result.id}/adjust`)
    } catch (e) {
      // 失敗時は遷移しない（ChatView に留まる）。
      // eslint-disable-next-line no-console
      console.error('[ChatView.onFinalize] createMinute failed', e)
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
