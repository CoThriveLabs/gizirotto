'use client'

import { useEffect } from 'react'

/**
 * 上限到達モーダル。
 *
 * 2 系統の上限を 1 モーダルで出し分ける:
 *  (a) AI 上限 (scope): AI route 429 AI_LIMIT_EXCEEDED 由来。family/user/global で文言切替。
 *  (b) リソース上限 (resource): 議事録/テンプレ INSERT 時の ResourceLimitError 由来。
 *
 * resource を渡すと (b) を優先表示。それ以外は (a) を表示。
 * 既存のモーダル基盤が無いため、最小限の inline 実装 (overlay + 中央 box)。
 * デザイン体系は gizirotto-blue 系トークンに合わせる。
 */

export type LimitScope = 'family' | 'user' | 'global'
export type LimitResource = 'minutes' | 'templates'

interface Props {
  open: boolean
  scope?: LimitScope | null
  resource?: LimitResource | null
  resetAt?: string | null
  onClose: () => void
}

function formatJst(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  // JST 表示 (年月日 時:分)
  const fmt = new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Tokyo',
  })
  return fmt.format(d)
}

function buildAiMessage(scope: LimitScope, resetAt: string | null | undefined): string {
  const reset = formatJst(resetAt)
  switch (scope) {
    case 'family':
      return reset
        ? `家族の今日の AI 利用回数を使い切りました。${reset} にリセットされます。`
        : '家族の今日の AI 利用回数を使い切りました。'
    case 'user':
      return reset
        ? `あなたの 1 時間あたりの AI 利用回数を使い切りました。${reset} にリセットされます。`
        : 'あなたの 1 時間あたりの AI 利用回数を使い切りました。'
    case 'global':
      return '現在、全体で AI 利用が制限中です。明日改めてお試しください。'
  }
}

function buildResourceMessage(resource: LimitResource): string {
  switch (resource) {
    case 'minutes':
      return '家族の今月の議事録上限に達しました。来月にリセットされます。'
    case 'templates':
      return '家族のテンプレート上限に達しました。不要なテンプレを削除すると追加できます。'
  }
}

export function LimitModal({ open, scope, resource, resetAt, onClose }: Props) {
  // Esc キーで閉じる
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // resource 優先 (Phase 0 follow-up): どちらも無ければ非表示。
  if (!open) return null
  if (!resource && !scope) return null
  const message = resource
    ? buildResourceMessage(resource)
    : scope
      ? buildAiMessage(scope, resetAt)
      : ''

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="limit-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="max-w-md w-full bg-white rounded-lg shadow-lg border border-gizirotto-blue-100 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="limit-modal-title"
          className="text-base font-medium text-gizirotto-blue-900"
        >
          利用上限に達しました
        </h2>
        <p className="mt-3 text-sm text-gray-700">{message}</p>
        <p className="mt-4 text-xs text-gray-500">
          家族管理画面から「リセット依頼」を送信できます (Phase 1 で提供予定)。
        </p>
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm bg-gizirotto-blue-100 text-gizirotto-blue-900 rounded hover:bg-gizirotto-blue-200"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}
