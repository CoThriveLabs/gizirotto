'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { createMinute, saveMinuteAdjust } from '@/server/minutes'
import { useToast } from '@/components/toast/toast-context'
import { LimitModal } from '@/components/usage/limit-modal'
import { ResourceLimitError } from '@/lib/db-error-mapper'
import {
  readFormCache,
  clearFormCache,
  getDraftStorageSafe,
  sweepExpiredFormCache,
  GUEST_SNAPSHOT_TTL_MS,
} from '@/lib/utils/form-cache'
import {
  guestAdjustDraftFormId,
  GUEST_ADJUST_DRAFT_RESTORE_PATH,
} from '@/lib/utils/guest-adjust-draft'
import type { GuestMinuteDraft } from '@/app/(dashboard)/minutes/[id]/adjust/AdjustView'

interface Props {
  templateId: string
  templateName: string
  fields: string[]
  /** When true the user is not logged in. createMinute is skipped; redirects to the guest AdjustView entry. */
  isGuest?: boolean
}

/**
 * /minutes/new/manual?template_id={id} のクライアント側ブートストラップ。
 *
 *   - 認証済み: mount 時に一度だけ Server Action `createMinute(...)` を呼ぶ（useRef ガードで
 *     React 18 StrictMode 二重 mount 対策 = single-shot）
 *     - 成功時: `router.replace('/minutes/{id}/adjust')` で AdjustView へ遷移
 *     - 失敗時: toast.error 表示 + 「テンプレ選択に戻る」リンク表示
 *   - 未ログイン (isGuest=true): createMinute を呼ばず、ゲスト向け AdjustView 到達ルート
 *     （/minutes/new/adjust）へ即遷移する。ログインユーザーと同じ画面で builtin レイアウトに
 *     直接記入できる（保存はそちら側で「ログインして保存」に出し分け）。
 *
 *   なぜ client から呼ぶか:
 *     createMinute 内部の `revalidatePath('/minutes')` が server component の render 中に
 *     発火すると Next.js が Runtime Error を投げるため。client mount 起点なら抵触しない。
 */
export function ManualBootstrap({ templateId, templateName, fields, isGuest = false }: Props) {
  const router = useRouter()
  const { showToast } = useToast()
  const startedRef = useRef(false)
  const [errored, setErrored] = useState(false)
  // 議事録上限到達時の LimitModal 表示状態
  const [limitOpen, setLimitOpen] = useState(false)

  useEffect(() => {
    // 未ログインはゲスト向け AdjustView 到達ルートへ即遷移（createMinute は呼ばない）。
    if (isGuest) {
      router.replace(`/minutes/new/adjust?template_id=${templateId}`)
      return
    }

    if (startedRef.current) return
    startedRef.current = true

    // ログイン直前にゲストとして AdjustView で「ログインして保存」した draft があれば復元する。
    // TTL 切れ・別テンプレ・そもそも無い場合は null（既存の空 content フローへフォールバック）。
    const storage = getDraftStorageSafe()
    // sweep の閾値は名前空間内の最大 TTL（save-draft の 30 分）で渡す。5 分固定にすると
    // 30 分 TTL の save-draft がまだ有効なうちに sweep で先に消されてしまう。
    sweepExpiredFormCache(storage, GUEST_SNAPSHOT_TTL_MS)
    const formId = guestAdjustDraftFormId(templateId)
    const entry = readFormCache<GuestMinuteDraft>(storage, formId, GUEST_SNAPSHOT_TTL_MS)
    const draft =
      entry && entry.expectedPath === GUEST_ADJUST_DRAFT_RESTORE_PATH ? entry.values : null

    const content: Record<string, string> = draft
      ? draft.content
      : fields.length === 0
        ? { メモ: '' }
        : Object.fromEntries(fields.map((name) => [name, '']))
    const title = draft?.title?.trim() || templateName
    const meetingDate = draft?.meetingDate || todayLocal()

    ;(async () => {
      try {
        const result = await createMinute({
          templateId,
          title,
          meetingDate,
          content,
          sourceMode: 'B-2',
        })
        // draft に bbox 位置調整 / 新規追加フィールドがあれば追加で反映する。
        // 失敗しても本体 content は既に保存済みなので致命ではない（AdjustView 上で再調整可能）。
        if (
          draft &&
          (Object.keys(draft.overrides).length > 0 || (draft.newFields?.length ?? 0) > 0)
        ) {
          try {
            await saveMinuteAdjust({
              id: result.id,
              overrides: draft.overrides,
              newFields: draft.newFields,
            })
          } catch (e) {
            console.error('[ManualBootstrap] draft overrides restore failed:', e)
          }
        }
        if (draft) clearFormCache(storage, formId)
        // builtin 新規作成時に初回サムネ生成を即 trigger（pending → ready へ前倒し）。
        // fire-and-forget: router.replace をブロックしない。失敗時 UI 反映は既存 markFailed 経路に委ねる。
        fetch(`/api/minutes/${result.id}/regenerate-thumbnail`, { method: 'POST' }).catch(() => {
          /* suppress — no auto-retry to avoid runaway requests */
        })
        router.replace(`/minutes/${result.id}/adjust`)
      } catch (e) {
        console.error('[ManualBootstrap] createMinute failed:', e)
        // 月次上限 (ResourceLimitError) は LimitModal で出し分け。
        // Server Action のシリアライズで instanceof が外れる場合も name + message 一致で判定。
        if (isResourceLimitMinutes(e)) {
          setLimitOpen(true)
          return
        }
        showToast('error', '議事録の準備に失敗しました')
        setErrored(true)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- Authenticated bootstrap mode ---
  // isGuest=true の間は上の useEffect の router.replace が解決するまでこの「準備中」表示を共用する。
  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      {/* 議事録月次上限 LimitModal */}
      <LimitModal
        open={limitOpen}
        resource="minutes"
        onClose={() => {
          setLimitOpen(false)
          // 上限の場合はテンプレ選択へ戻す動線が自然
          router.replace('/minutes/new')
        }}
      />
      {errored ? (
        <div className="flex flex-col items-center gap-4 text-center">
          <p className="text-sm text-gray-700">
            議事録の準備に失敗しました。時間をおいて再度お試しください。
          </p>
          <Link
            href="/minutes/new"
            className="inline-flex items-center justify-center rounded border border-gizirotto-blue-300 bg-white px-4 py-2 text-sm text-gizirotto-blue-700 hover:bg-gizirotto-blue-50"
          >
            テンプレ選択に戻る
          </Link>
        </div>
      ) : (
        <div
          role="status"
          aria-live="polite"
          className="flex flex-col items-center gap-3"
        >
          <span
            aria-hidden="true"
            className="inline-block w-8 h-8 border-2 border-gizirotto-blue-200 border-t-gizirotto-blue-600 rounded-full animate-spin"
          />
          <p className="text-sm text-gizirotto-blue-700">準備中…</p>
        </div>
      )}
    </div>
  )
}

function todayLocal(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function isResourceLimitMinutes(e: unknown): boolean {
  if (e instanceof ResourceLimitError) return e.resource === 'minutes'
  if (e instanceof Error) {
    const maybe = e as Error & { resource?: unknown }
    if (
      e.name === 'ResourceLimitError' &&
      e.message === 'RESOURCE_LIMIT_EXCEEDED' &&
      maybe.resource === 'minutes'
    ) {
      return true
    }
  }
  return false
}
