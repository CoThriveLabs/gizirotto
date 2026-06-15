'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { regenerateInviteCode } from '@/server/families'

/**
 * 招待コード再発行ボタン（Phase 5b §1-10）。
 * admin only、confirm modal 経由、擬人化エラー UX、re-validate で新コード自動表示。
 */
export function RegenerateInviteCodeButton() {
  const router = useRouter()
  const [modalOpen, setModalOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  function onClickRegenerate() {
    setModalOpen(false)
    setErrorMsg(null)
    startTransition(async () => {
      const result = await regenerateInviteCode()
      if (result.ok) {
        router.refresh()
      } else {
        setErrorMsg(
          result.code === 'NOT_ADMIN'
            ? '招待コードを再発行できるのは管理者だけです。'
            : '再発行に失敗しました。少し時間を置いて再度お試しください。',
        )
      }
    })
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setModalOpen(true)}
        disabled={isPending}
        className="text-sm border border-gizirotto-blue-300 text-gizirotto-blue-700 px-3 py-2 rounded hover:bg-gizirotto-blue-50 disabled:opacity-50"
      >
        {isPending ? '再発行中…' : '再発行する'}
      </button>

      {errorMsg && (
        <p className="text-xs text-red-600 mt-2" role="alert">
          {errorMsg}
        </p>
      )}

      {modalOpen && (
        <div
          role="dialog"
          aria-labelledby="regenerate-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setModalOpen(false)}
        >
          <div
            className="bg-white rounded-lg shadow-lg max-w-md w-full p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="regenerate-title" className="text-base font-medium text-gizirotto-blue-900">
              招待コードを再発行しますか？
            </h3>
            <p className="text-sm text-gray-700">
              現在の招待コードは無効になります。新しいコードを家族メンバーに伝えてください。
            </p>
            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="text-sm text-gray-600 hover:text-gray-800 px-3 py-1"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={onClickRegenerate}
                className="bg-gizirotto-blue-700 text-white px-5 py-2 rounded hover:bg-gizirotto-blue-800 text-sm"
              >
                再発行する
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
