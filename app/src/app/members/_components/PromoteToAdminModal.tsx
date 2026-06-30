'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { promoteMemberToAdmin } from '@/server/families'

interface Props {
  memberId: string
  displayName: string
  onClose: () => void
}

/**
 * 「<displayName> さんを管理者に昇格」確認モーダル。
 * 確定で promoteMemberToAdmin → router.refresh() でメンバー画面を再描画。
 */
export function PromoteToAdminModal({ memberId, displayName, onClose }: Props) {
  const router = useRouter()
  const titleId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function handlePromote() {
    setSubmitting(true)
    setError(null)
    const res = await promoteMemberToAdmin(memberId)
    if (res.ok) {
      router.refresh()
      onClose()
      return
    }
    const msg =
      res.code === 'ALREADY_ADMIN'
        ? 'このメンバーは既に管理者です。'
        : res.code === 'NOT_ADMIN'
          ? '管理者のみが昇格を実行できます。'
          : res.code === 'TARGET_NOT_IN_FAMILY'
            ? '対象メンバーが家族に存在しません。'
            : res.code === 'UNAUTHENTICATED'
              ? '認証が切れています。再度ログインしてください。'
              : '昇格に失敗しました。'
    setError(msg)
    setSubmitting(false)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div className="bg-white rounded-lg shadow-xl max-w-sm w-full">
        <div className="p-6 space-y-4">
          <h2
            id={titleId}
            className="text-lg font-serif text-gizirotto-blue-900"
          >
            管理者に昇格
          </h2>
          <p className="text-sm text-gray-800">
            「{displayName}」さんを管理者に昇格します。よろしいですか？
          </p>
          <p className="text-xs text-gray-600">
            管理者になると、招待コード発行・メンバー管理など家族管理の全権限を持ちます。
          </p>
          {error && (
            <p className="text-red-600 text-sm" role="alert">
              {error}
            </p>
          )}
          <div className="flex gap-2 justify-end pt-2">
            <button
              ref={cancelRef}
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium px-4 py-2 rounded disabled:opacity-50"
            >
              キャンセル
            </button>
            <button
              type="button"
              onClick={handlePromote}
              disabled={submitting}
              className="bg-gizirotto-blue-500 hover:bg-gizirotto-blue-700 text-white font-medium px-4 py-2 rounded disabled:opacity-50"
            >
              {submitting ? '昇格中…' : '昇格する'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
