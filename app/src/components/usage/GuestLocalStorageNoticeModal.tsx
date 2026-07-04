'use client'

import { useEffect } from 'react'

/**
 * ゲスト（未ログイン）下書きの localStorage 保存についての案内モーダル。
 * デザイン体系・構造は limit-modal.tsx を踏襲する。
 */

interface Props {
  open: boolean
  onClose: () => void
}

export function GuestLocalStorageNoticeModal({ open, onClose }: Props) {
  // Esc キーで閉じる
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="guest-ls-notice-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="max-w-md w-full bg-white rounded-lg shadow-lg border border-gizirotto-blue-100 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="guest-ls-notice-modal-title"
          className="text-base font-medium text-gizirotto-blue-900"
        >
          下書きの保存についてのご案内
        </h2>
        <p className="mt-3 text-sm text-gray-700">
          ログインせずに作成した下書きは、この端末のブラウザに一時的に保存されます。共有のパソコンをご利用の場合はご注意ください。
        </p>
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm bg-gizirotto-blue-100 text-gizirotto-blue-900 rounded hover:bg-gizirotto-blue-200"
          >
            はじめる
          </button>
        </div>
      </div>
    </div>
  )
}
