'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { deleteMinute } from '@/server/minutes'

interface Props {
  minuteId: string
  title: string
}

/**
 * 編集系ボタン群（ヘッダー上配置）。
 * - 編集 → /minutes/[id]/adjust（実体は AdjustView 経路）。
 *   `/minutes/[id]/edit` ルートは後方互換のため残置（後日削除予定）。
 * - 削除 → confirm modal + RPC delete_minute_with_files
 *
 * 🔴 D9: 旧配置（プレビュー下「テキストリンク + 削除右寄せ」）から
 *   OutputButtons と同型 wrapper（`flex flex-col gap-2 items-end` +
 *   `flex flex-wrap gap-2 justify-end`）の bordered button に揃える。
 *   page.tsx の header 右側に並べることでテンプレ編集モード等の他画面 UI と統一。
 *   ロジック（onClick / confirm / router.push）は完全不変。
 */
export function MinutesActions({ minuteId, title }: Props) {
  const router = useRouter()
  const [deleting, setDeleting] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  async function onDelete() {
    // TODO(Phase 6): ゴミ箱復元実装時に文言「30日以内に復元可」へ書換え
    if (!confirm(`「${title}」を削除します。元に戻せません。`)) return
    setDeleting(true)
    setErrorMsg(null)
    try {
      await deleteMinute(minuteId)
      router.push('/minutes')
    } catch (e) {
      setErrorMsg(
        e instanceof Error && e.message === 'NOT_AUTHORIZED'
          ? '権限がありません。'
          : '削除に失敗しました。少し時間を置いて再度お試しください。',
      )
      setDeleting(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 items-end">
      <div className="flex flex-wrap gap-2 justify-end">
        <Link
          href={`/minutes/${minuteId}/adjust`}
          className="text-sm border border-gizirotto-blue-300 text-gizirotto-blue-700 px-3 py-2 rounded hover:bg-gizirotto-blue-50"
        >
          編集
        </Link>
        <button
          type="button"
          onClick={onDelete}
          disabled={deleting}
          className="text-sm border border-red-300 text-red-600 px-3 py-2 rounded hover:bg-red-50 disabled:opacity-50"
        >
          {deleting ? '削除中…' : '削除'}
        </button>
      </div>
      {errorMsg && (
        <p className="text-xs text-red-600 max-w-xs text-right" role="alert">
          {errorMsg}
        </p>
      )}
    </div>
  )
}
