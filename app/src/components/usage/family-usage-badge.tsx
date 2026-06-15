'use client'

import { useFamilyUsage } from '@/hooks/use-family-usage'

/**
 * 議事録作成画面ヘッダ右の残数バッジ。
 *
 * AI: 当日の家族 AI 呼出回数。80% 越え=黄、95% 以上=赤。
 * 議事録: 当月の議事録件数。同じ閾値で色変化。
 *
 * 取得失敗時 / 未ログイン時は何も表示しない (UI を壊さない)。
 */

const colorClass = {
  default: 'bg-gray-100 text-gray-700 border-gray-200',
  yellow: 'bg-yellow-50 text-yellow-800 border-yellow-300',
  red: 'bg-red-50 text-red-800 border-red-300',
} as const

function classify(pct: number): keyof typeof colorClass {
  if (pct >= 0.95) return 'red'
  if (pct >= 0.8) return 'yellow'
  return 'default'
}

export function FamilyUsageBadge() {
  const { data, loading } = useFamilyUsage()
  if (loading || !data) return null

  const aiPct = data.ai.cap > 0 ? data.ai.used / data.ai.cap : 0
  const minutesPct = data.minutes.cap > 0 ? data.minutes.used / data.minutes.cap : 0

  const aiColor = colorClass[classify(aiPct)]
  const minutesColor = colorClass[classify(minutesPct)]

  return (
    <div className="flex gap-2 text-xs" data-testid="family-usage-badge">
      <span
        className={`inline-flex items-center rounded border px-2 py-0.5 ${aiColor}`}
        aria-label={`AI 使用 ${data.ai.used} / 上限 ${data.ai.cap}`}
      >
        AI: {data.ai.used}/{data.ai.cap}
      </span>
      <span
        className={`inline-flex items-center rounded border px-2 py-0.5 ${minutesColor}`}
        aria-label={`議事録 ${data.minutes.used} / 上限 ${data.minutes.cap}`}
      >
        議事録: {data.minutes.used}/{data.minutes.cap}
      </span>
    </div>
  )
}
