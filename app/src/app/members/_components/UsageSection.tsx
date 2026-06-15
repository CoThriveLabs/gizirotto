'use client'

/**
 * 家族管理画面の使用量セクション。
 *
 * AI (当日) / 議事録 (当月) / テンプレ (累積) のプログレスバー +
 * 「運営へリセット依頼を送信」ボタン。1 家族 1 日 1 回 (当日依頼済なら disable)。
 */

import { useEffect, useState } from 'react'
import { useFamilyUsage } from '@/hooks/use-family-usage'

type Slot = { used: number; cap: number }

function Bar({
  label,
  slot,
}: {
  label: string
  slot: Slot
}) {
  const pct = slot.cap > 0 ? Math.min(100, (slot.used / slot.cap) * 100) : 0
  const color =
    pct >= 95 ? 'bg-red-500' : pct >= 80 ? 'bg-yellow-400' : 'bg-gizirotto-blue-500'
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-gray-600">
        <span>{label}</span>
        <span>
          {slot.used} / {slot.cap}
        </span>
      </div>
      <div className="h-2 w-full rounded bg-gray-100 overflow-hidden">
        <div
          className={`h-full ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

export function UsageSection() {
  const { data, loading } = useFamilyUsage()
  const [requestedToday, setRequestedToday] = useState<boolean | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    fetch('/api/family/request-reset', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (active && j) setRequestedToday(j.requestedToday === true)
      })
      .catch(() => {
        /* 取得失敗時はボタンを有効のままにする */
      })
    return () => {
      active = false
    }
  }, [])

  async function onRequestReset() {
    if (submitting) return
    setSubmitting(true)
    setMessage(null)
    try {
      const res = await fetch('/api/family/request-reset', { method: 'POST' })
      if (res.status === 429) {
        setRequestedToday(true)
        setMessage('本日は既にリセット依頼を送信済みです。')
      } else if (res.ok) {
        setRequestedToday(true)
        setMessage('リセット依頼を送信しました。')
      } else {
        setMessage('送信に失敗しました。時間を置いて再度お試しください。')
      }
    } catch {
      setMessage('送信に失敗しました。時間を置いて再度お試しください。')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading || !data) return null

  return (
    <section className="bg-white border border-gizirotto-blue-200 rounded-lg p-6 space-y-4">
      <h2 className="text-sm font-medium text-gray-700">今の使用量</h2>
      <div className="space-y-3">
        <Bar label="AI（今日）" slot={data.ai} />
        <Bar label="議事録（今月）" slot={data.minutes} />
        <Bar label="テンプレート" slot={data.templates} />
      </div>

      <div className="space-y-2 pt-2 border-t border-gray-100">
        <button
          type="button"
          onClick={onRequestReset}
          disabled={submitting || requestedToday === true}
          className="w-full bg-gizirotto-blue-500 hover:bg-gizirotto-blue-700 text-white text-sm font-medium py-2 rounded disabled:opacity-50"
        >
          {requestedToday === true
            ? '本日は依頼済みです'
            : submitting
              ? '送信中…'
              : '運営へリセット依頼を送信'}
        </button>
        {message && <p className="text-xs text-gray-600">{message}</p>}
      </div>
    </section>
  )
}
