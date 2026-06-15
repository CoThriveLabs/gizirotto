'use client'

/**
 * 使用量 80% 警告 banner。
 *
 * useFamilyUsage hook を流用 (戻り値 { data, loading } / data.ai = { used, cap })。
 * AI 使用率が 80% を超えたら議事録一覧上部に黄色 banner を出す。
 * 取得失敗時 / 未ログイン時 / cap=0 は何も表示しない。
 */

import { useFamilyUsage } from '@/hooks/use-family-usage'

export function UsageBanner() {
  const { data, loading } = useFamilyUsage()
  if (loading || !data) return null

  const ai = data.ai
  if (!ai || ai.cap === 0) return null
  const pct = ai.used / ai.cap
  if (pct < 0.8) return null

  const remaining = Math.max(0, ai.cap - ai.used)
  return (
    <div className="bg-yellow-50 border border-yellow-300 text-yellow-800 text-sm rounded px-3 py-2">
      あと {remaining} 回で家族の今日の AI 上限です。
    </div>
  )
}
