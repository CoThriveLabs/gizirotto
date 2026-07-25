'use client'

/**
 * ChatView の議事録化（onFinalize）を束ねる custom hook。
 *
 * messages/turnstileGate/clearSnapshot/setErrorMsg/setLimitModal は Container 側の共有 state を
 * そのまま注入する。router は hook 内で直接取得する。
 */
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import {
  extractFieldsFromChat,
} from '@/server/chat-sessions'
import { createMinute } from '@/server/minutes'
import { humanizeErrorCode } from '@/lib/errors/user-message'
import { ResourceLimitError } from '@/lib/db-error-mapper'
import { writeFormCache, getDraftStorageSafe } from '@/lib/utils/form-cache'
import {
  guestChatDraftFormId,
  GUEST_CHAT_DRAFT_RESTORE_PATH,
  guestAdjustDraftFormId,
  GUEST_ADJUST_DRAFT_RESTORE_PATH,
} from '@/lib/utils/guest-adjust-draft'
import type { UseGuestTurnstileGate } from '@/hooks/useGuestTurnstileGate'
import type { GuestMinuteDraft } from '@/app/(dashboard)/minutes/[id]/adjust/AdjustView'
import type { ChatMessage, ChatLimitModalState, TemplateField } from './ChatView'

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

function todayIso(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export interface UseChatFinalizeParams {
  templateId: string
  templateName: string
  mode: 'A-1' | 'A-2'
  fields: TemplateField[]
  isGuest?: boolean
  needsFamilySetup?: boolean
  messages: ChatMessage[]
  turnstileGate: UseGuestTurnstileGate
  clearSnapshot: () => void
  setErrorMsg: (v: string | null) => void
  setLimitModal: React.Dispatch<React.SetStateAction<ChatLimitModalState>>
}

export interface UseChatFinalizeReturn {
  finalizing: boolean
  onFinalize: () => Promise<void>
}

export function useChatFinalize({
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
}: UseChatFinalizeParams): UseChatFinalizeReturn {
  const router = useRouter()
  const [finalizing, setFinalizing] = useState(false)

  async function onFinalize() {
    setFinalizing(true)
    setErrorMsg(null)

    // AI で会話履歴を各 field に項目別バインドする。
    // 失敗時 fallback = 最初の field に memo 詰め + 確認画面に警告表示。
    let content: Record<string, string>
    let extractFailed = false
    // result は try 内で代入され、meetingDate 確定（下方）は try の外。extractFailed 時は
    // undefined になり得るので上位スコープで宣言し result?.meetingDate の optional chain で扱う。
    let result: { values: Record<string, string>; meetingDate?: string } | undefined
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
        // Turnstile トークンは gate.consumeToken() で到着待ち（enabled=false 時は undefined）。
        // 直前の送信で消費済みなら waiter で新チャレンジ到着まで待機する。
        if (isGuest) {
          const capturedToken = await turnstileGate.consumeToken()
          const res = await fetch('/api/minutes/chat/extract-fields', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              templateId,
              conversation: messages,
              ...(capturedToken !== undefined ? { turnstileToken: capturedToken } : {}),
            }),
          })
          if (!res.ok) {
            // トークンを使い切ったので次回チャレンジを明示発火。既存 catch が memo dump に落とす。
            turnstileGate.reset()
            throw new Error('EXTRACT_FIELDS_FAILED')
          }
          result = (await res.json()) as {
            values: Record<string, string>
            meetingDate?: string
          }
          // 成功時: 次回チャレンジ発火（Cloudflare 仕様上明示 reset が必要）。
          turnstileGate.reset()
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

    // ここで createMinute を 1 回実行し、そのまま AdjustView へ遷移する。
    // 振り分け失敗 warning は sessionStorage に残し、AdjustView 初回マウントで toast 化。
    // タブ単位で完結する一発通知のため、ここは localStorage 化しない。
    const title = `${templateName} ${new Date().toLocaleDateString('ja-JP')}`
    // 会話で開催日が絶対日付として抽出されていればそれを、無ければ暫定で今日（開催日欄で手動調整可）。
    const extractedMeetingDate =
      typeof result?.meetingDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(result.meetingDate)
        ? result.meetingDate
        : null
    const meetingDate = extractedMeetingDate ?? todayIso()
    if (extractFailed) {
      sessionStorage.setItem(
        'minutes:draft-warning',
        'うまく振り分けられませんでした。編集画面で手動で編集してください。',
      )
    } else {
      sessionStorage.removeItem('minutes:draft-warning')
    }

    // ゲストは minute レコードを持てない。抽出済み content を一度きりの form-cache エントリで
    // ゲスト向け AdjustView 到達ルートへ渡し、そのまま遷移する（createMinute は呼ばない）。
    // content と meta（meetingDate）を分離したネスト構造で保存。GuestAdjustBootstrap 側が
    // { content, meetingDate } 形式で読む。form-cache（TTL 付き）経由にすることで、sweep による
    // 期限切れ掃除の対象にも入り、無期限に残留しない。writeFormCache は書き込み失敗を内部で
    // 握り潰すため、ここでの try/catch は不要。
    if (isGuest) {
      writeFormCache(
        getDraftStorageSafe(),
        guestChatDraftFormId(templateId),
        { content, meetingDate },
        GUEST_CHAT_DRAFT_RESTORE_PATH,
      )
      clearSnapshot()
      router.push(`/minutes/new/adjust?template_id=${templateId}`)
      return
    }

    // ログイン済みだが family 未参加。createMinute は NOT_IN_FAMILY で必ず失敗するため、
    // 抽出済み content をゲスト保存導線（手動側）と同じ save-draft キー・expectedPath で
    // 書き込み、家族作成/参加へ寄り道させる。ManualBootstrap が家族作成後にこのエントリを
    // 読んで本保存する（新しい復元機構は作らない）。
    if (needsFamilySetup) {
      const draft: GuestMinuteDraft = {
        templateId,
        title,
        meetingDate,
        content,
        overrides: {},
      }
      writeFormCache(
        getDraftStorageSafe(),
        guestAdjustDraftFormId(templateId),
        draft,
        GUEST_ADJUST_DRAFT_RESTORE_PATH,
      )
      clearSnapshot()
      const returnTo = `/minutes/new/manual?template_id=${templateId}`
      router.replace(`/family/setup?next=${encodeURIComponent(returnTo)}`)
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

  return { finalizing, onFinalize }
}
