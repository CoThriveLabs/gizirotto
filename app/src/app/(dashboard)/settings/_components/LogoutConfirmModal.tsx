'use client'

/**
 * LogoutConfirmModal — ログアウト確認モーダル（dumb component）。
 *
 * 表示制御 (open) / 確認 / キャンセル / loading / error はすべて props 注入。
 * 実 API 呼び出し（/api/auth/logout）と router 遷移は呼出側責任。
 *
 * a11y:
 *   - role="dialog" aria-modal="true" aria-labelledby
 *   - Esc キーで onCancel (loading 中は無視)
 *   - mount 時にキャンセルボタンへ自動 focus (破壊操作回避の安全側)
 *   - 背景クリックで onCancel (loading 中は無視・パネル内は stopPropagation)
 *   - 全ボタン disabled={loading} で多重操作防止
 */

import { useEffect, useRef } from 'react'

export interface LogoutConfirmModalProps {
  /** モーダル表示制御。false なら DOM 描画しない (null return)。 */
  open: boolean
  /** 「はい、ログアウト」押下時のハンドラ。await で完了を待つ。 */
  onConfirm: () => void | Promise<void>
  /** 「キャンセル」/ Esc / 背景クリック押下時のハンドラ。 */
  onCancel: () => void
  /** 実行中フラグ（ボタン disable + 文言切替）。デフォルト false。 */
  loading?: boolean
  /** エラーメッセージ。null で非表示。 */
  error?: string | null
}

const TITLE_ID = 'logout-confirm-modal-title'

export function LogoutConfirmModal({
  open,
  onConfirm,
  onCancel,
  loading = false,
  error = null,
}: LogoutConfirmModalProps) {
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)

  // Esc キー閉じ (loading 中は無視)。
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (loading) return
      onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, loading, onCancel])

  // マウント時にキャンセルボタンへ初期 focus (破壊操作回避の安全側)。
  useEffect(() => {
    if (!open) return
    cancelButtonRef.current?.focus()
  }, [open])

  if (!open) return null

  function handleOverlayClick() {
    if (loading) return
    onCancel()
  }

  function handlePanelClick(e: React.MouseEvent) {
    e.stopPropagation()
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={TITLE_ID}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4"
      onClick={handleOverlayClick}
    >
      <div
        className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl"
        onClick={handlePanelClick}
        aria-busy={loading}
      >
        <h3 id={TITLE_ID} className="text-base font-medium text-gray-900">
          ログアウトしますか？
        </h3>
        <p className="mt-2 text-sm text-gray-600">
          ログアウトすると、再びログインするまで議事録の閲覧・編集はできません。
        </p>
        {error && (
          <p
            className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2"
            role="alert"
          >
            {error}
          </p>
        )}
        <div className="mt-5 flex flex-col gap-2">
          <button
            type="button"
            onClick={() => void onConfirm()}
            disabled={loading}
            className="w-full rounded bg-gizirotto-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-gizirotto-blue-700 disabled:opacity-60"
          >
            {loading ? 'ログアウト中…' : 'はい、ログアウト'}
          </button>
          <button
            type="button"
            ref={cancelButtonRef}
            onClick={onCancel}
            disabled={loading}
            className="w-full rounded border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
          >
            キャンセル
          </button>
        </div>
      </div>
    </div>
  )
}
