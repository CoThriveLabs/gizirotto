'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { LogoutConfirmModal } from './LogoutConfirmModal'

/**
 * ログアウトボタン。
 * クリックで確認モーダル表示 → 「はい」で /api/auth/logout に POST → ホーム遷移 + SSR 再評価。
 * 401（既ログアウト）は成功扱い、500 系のみモーダル内エラー表示。
 */
export function LogoutButton() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleConfirm() {
    setError(null)
    setLoading(true)
    try {
      const res = await fetch('/api/auth/logout', { method: 'POST' })
      if (!res.ok && res.status !== 401) {
        // 401（既ログアウト）は成功扱い、それ以外の非 2xx は失敗
        throw new Error('LOGOUT_FAILED')
      }
      // cookie 削除後の SSR 反映のため push + refresh をセットで呼ぶ
      // 遷移後にモーダルは unmount されるので setOpen(false) は不要
      router.push('/')
      router.refresh()
    } catch {
      setError('ログアウトに失敗しました。もう一度お試しください。')
      setLoading(false)
    }
  }

  function handleCancel() {
    setOpen(false)
    setError(null)
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label="ログアウト"
        className="bg-gizirotto-blue-500 hover:bg-gizirotto-blue-700 text-white font-medium px-4 py-2 rounded"
      >
        ログアウト
      </button>
      <LogoutConfirmModal
        open={open}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
        loading={loading}
        error={error}
      />
    </div>
  )
}
