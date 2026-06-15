'use client'

import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { useEffect, useRef, useState, useTransition } from 'react'
import type { MinutesListItem } from '@/server/minutes'
import { deleteMinute } from '@/server/minutes'
import { UsageBanner } from '@/components/usage/UsageBanner'

interface Props {
  items: MinutesListItem[]
  totalCount: number
  page: number
  pageSize: number
  currentMonth: string
}

export function MinutesListView({
  items,
  totalCount,
  page,
  pageSize,
  currentMonth,
}: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))

  function onMonthChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value
    startTransition(() => {
      const params = new URLSearchParams()
      if (value) params.set('month', value)
      router.push(`/minutes?${params.toString()}`)
    })
  }

  async function onConfirmDelete(id: string, title: string) {
    if (!confirm(`「${title}」を削除します。元に戻せません。`)) return
    setDeletingId(id)
    setErrorMsg(null)
    try {
      await deleteMinute(id)
      router.refresh()
    } catch (e) {
      setErrorMsg(
        e instanceof Error && e.message === 'NOT_AUTHORIZED'
          ? '権限がありません。'
          : '削除に失敗しました。少し時間を置いて再度お試しください。',
      )
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="space-y-4">
      <UsageBanner />

      <div className="flex items-center gap-3">
        <label className="text-xs text-gray-600">月で絞り込み</label>
        <select
          value={currentMonth}
          onChange={onMonthChange}
          disabled={isPending}
          className="border border-gizirotto-blue-200 rounded px-2 py-1 text-sm"
        >
          <option value="">すべて</option>
          {generateMonthOptions().map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      {errorMsg && (
        <p className="text-sm text-red-600" role="alert">
          {errorMsg}
        </p>
      )}

      {items.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {items.map((m) => (
            <li
              key={m.id}
              className="bg-white border border-gizirotto-blue-100 rounded p-3 flex gap-3 items-start"
            >
              <Link
                href={`/minutes/${m.id}`}
                className="flex gap-3 flex-1 min-w-0 hover:opacity-80"
              >
                <MinuteThumb item={m} />

                <div className="flex-1 min-w-0">
                  <h2 className="text-sm font-medium text-gizirotto-blue-900 truncate">
                    {m.title}
                  </h2>
                  <p className="text-xs text-gray-500 mt-1">
                    {formatJpDate(m.meeting_date)}
                  </p>
                  {m.template_name && (
                    <p className="text-xs text-gizirotto-blue-600 mt-1">
                      {m.template_name}
                    </p>
                  )}
                </div>
              </Link>
              <button
                type="button"
                onClick={() => onConfirmDelete(m.id, m.title)}
                disabled={deletingId === m.id}
                className="text-xs text-gray-500 hover:text-red-600 disabled:opacity-50"
                aria-label={`${m.title} を削除`}
              >
                削除
              </button>
            </li>
          ))}
        </ul>
      )}

      {totalPages > 1 && (
        <nav className="flex items-center justify-center gap-2 pt-4">
          {page > 1 && (
            <Link
              href={pageUrl(currentMonth, page - 1)}
              className="text-sm text-gizirotto-blue-700 hover:underline"
            >
              ← 前のページ
            </Link>
          )}
          <span className="text-xs text-gray-500">
            {page} / {totalPages}
          </span>
          {page < totalPages && (
            <Link
              href={pageUrl(currentMonth, page + 1)}
              className="text-sm text-gizirotto-blue-700 hover:underline"
            >
              次のページ →
            </Link>
          )}
        </nav>
      )}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="bg-white border border-gizirotto-blue-100 rounded p-8 text-center space-y-3">
      <p className="text-sm text-gray-600">まだ議事録はありません</p>
      <Link
        href="/templates?from=cta&intent=ai"
        className="inline-block text-sm bg-gizirotto-blue-700 text-white px-4 py-2 rounded hover:bg-gizirotto-blue-800"
      >
        ＋ 新しく議事録を作る
      </Link>
    </div>
  )
}

function pageUrl(month: string, page: number): string {
  const params = new URLSearchParams()
  if (month) params.set('month', month)
  if (page > 1) params.set('page', String(page))
  const qs = params.toString()
  return qs ? `/minutes?${qs}` : '/minutes'
}

function formatJpDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

/**
 * 一覧ページのサムネセル。
 *
 * - ready: Image 表示（従来）
 * - pending: 「準備中…」プレースホルダ + on-demand 自動 trigger（§3.6.2）
 * - failed: 再生成ボタン（80x112 px 枠内・サイズ小さめ）
 *
 * α ループ防止構造保証:
 *   - 自動 trigger は pending のみ・failed 非発火
 *   - triggeredRef で同マウント 1 回保護
 */
function MinuteThumb({ item }: { item: MinutesListItem }) {
  const router = useRouter()
  const triggeredRef = useRef(false)
  const [regenerating, setRegenerating] = useState(false)
  const status = item.thumbnail_status as
    | 'ready'
    | 'pending'
    | 'failed'
    | 'skipped'
    | string

  useEffect(() => {
    if (status !== 'pending') return
    if (triggeredRef.current) return
    triggeredRef.current = true
    fetch(`/api/minutes/${item.id}/regenerate-thumbnail`, { method: 'POST' })
      .then((r) => {
        if (r.ok) router.refresh()
      })
      .catch(() => {
        /* 黙殺（§3.6.2 拡大解釈禁止） */
      })
  }, [item.id, status, router])

  async function handleRegenerate(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (regenerating) return
    setRegenerating(true)
    try {
      const res = await fetch(`/api/minutes/${item.id}/regenerate-thumbnail`, {
        method: 'POST',
      })
      if (res.ok) router.refresh()
    } catch {
      /* alert は出さない（既存 deleteMinute と整合） */
    } finally {
      setRegenerating(false)
    }
  }

  if (status === 'ready' && item.signedThumbUrl) {
    return (
      <div className="w-20 h-28 bg-gizirotto-blue-50 rounded overflow-hidden flex items-center justify-center shrink-0">
        <Image
          src={item.signedThumbUrl}
          alt=""
          width={80}
          height={112}
          className="object-cover"
        />
      </div>
    )
  }
  if (status === 'pending') {
    return (
      <div className="w-20 h-28 bg-gizirotto-blue-50 rounded overflow-hidden flex flex-col items-center justify-center shrink-0 gap-1 text-gray-400">
        <span
          aria-hidden="true"
          className="inline-block w-4 h-4 border-2 border-gray-300 border-t-gray-500 rounded-full animate-spin"
        />
        <span className="text-[10px]">準備中…</span>
      </div>
    )
  }
  // failed / skipped / その他
  return (
    <div className="w-20 h-28 bg-gray-100 rounded overflow-hidden flex flex-col items-center justify-center shrink-0 gap-1 relative">
      <span className="text-[10px] text-red-600">生成失敗</span>
      <button
        type="button"
        onClick={handleRegenerate}
        disabled={regenerating}
        className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-white border border-gray-300 text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-50"
      >
        {regenerating ? '生成中…' : '再生成'}
      </button>
    </div>
  )
}

function generateMonthOptions(): string[] {
  // 直近 24 ヶ月を YYYY-MM 形式で生成（家庭利用想定で 2 年分）
  const months: string[] = []
  const now = new Date()
  for (let i = 0; i < 24; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    months.push(`${y}-${m}`)
  }
  return months
}
