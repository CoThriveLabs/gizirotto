'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  countTemplateRefs,
  deleteTemplate,
  type DeleteTemplateMode,
} from '@/server/templates'
import ErrorNotice from '@/components/error-notice'

interface Props {
  templateId: string
  templateName: string
  open: boolean
  onClose: () => void
  onDeleted?: () => void
}

type Counts = { minutes: number; chatSessions: number }

export function DeleteTemplateModal({
  templateId,
  templateName,
  open,
  onClose,
  onDeleted,
}: Props) {
  const router = useRouter()
  const [counts, setCounts] = useState<Counts | null>(null)
  const [loadingCounts, setLoadingCounts] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setCounts(null)
      setError(null)
      setSubmitting(false)
      return
    }
    let cancelled = false
    setLoadingCounts(true)
    setError(null)
    countTemplateRefs(templateId)
      .then((c) => {
        if (!cancelled) setCounts(c)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'unknown')
      })
      .finally(() => {
        if (!cancelled) setLoadingCounts(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, templateId])

  async function handleDelete(mode: DeleteTemplateMode) {
    setSubmitting(true)
    setError(null)
    try {
      await deleteTemplate(templateId, mode)
      onDeleted?.()
      router.refresh()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown')
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) return null

  const hasRefs = counts !== null && (counts.minutes > 0 || counts.chatSessions > 0)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-template-title"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="delete-template-title"
          className="text-lg font-serif text-gizirotto-blue-900"
        >
          「{templateName}」を削除しますか？
        </h2>

        {loadingCounts && (
          <p className="text-sm text-gray-500">関連する議事録を確認中…</p>
        )}

        {counts && !loadingCounts && (
          <div className="text-sm text-gray-700 space-y-2">
            {hasRefs ? (
              <>
                <p>
                  このテンプレで作った
                  <span className="font-bold text-gizirotto-blue-900">
                    {' '}議事録 {counts.minutes} 件
                  </span>
                  ・
                  <span className="font-bold text-gizirotto-blue-900">
                    チャット履歴 {counts.chatSessions} 件
                  </span>
                  があります。
                </p>
                <p className="text-xs text-gray-500">
                  「テンプレだけ削除」を選ぶと、議事録はそのまま残ります。
                </p>
              </>
            ) : (
              <p>このテンプレを使った議事録・チャットはありません。</p>
            )}
          </div>
        )}

        {error && <ErrorNotice code={error} prefix="削除に失敗しました" />}

        <div className="flex flex-col gap-2 pt-2">
          {hasRefs && (
            <>
              <button
                type="button"
                disabled={submitting || loadingCounts}
                onClick={() => handleDelete('template_only')}
                className="w-full px-4 py-2 text-sm border border-gizirotto-blue-500 text-gizirotto-blue-700 hover:bg-gizirotto-blue-50 rounded disabled:opacity-50"
              >
                テンプレだけ削除（議事録は残す）
              </button>
              <button
                type="button"
                disabled={submitting || loadingCounts}
                onClick={() => handleDelete('with_minutes')}
                className="w-full px-4 py-2 text-sm bg-red-600 text-white hover:bg-red-700 rounded disabled:opacity-50"
              >
                議事録も一緒に削除
              </button>
            </>
          )}
          {!hasRefs && counts && (
            <button
              type="button"
              disabled={submitting || loadingCounts}
              onClick={() => handleDelete('template_only')}
              className="w-full px-4 py-2 text-sm bg-red-600 text-white hover:bg-red-700 rounded disabled:opacity-50"
            >
              {submitting ? '削除中…' : '削除する'}
            </button>
          )}
          <button
            type="button"
            disabled={submitting}
            onClick={onClose}
            className="w-full px-4 py-2 text-sm border border-gray-300 text-gray-700 hover:bg-gray-50 rounded disabled:opacity-50"
          >
            キャンセル
          </button>
        </div>
      </div>
    </div>
  )
}
