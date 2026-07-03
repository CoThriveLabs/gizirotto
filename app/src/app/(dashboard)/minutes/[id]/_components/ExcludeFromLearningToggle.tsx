'use client'

import { useState } from 'react'
import { updateMinute } from '@/server/minutes'

interface Props {
  minuteId: string
  initialExcluded: boolean
}

/**
 * 議事録単位で「この議事録は書き方の学習に使わない」を切り替えるトグル。
 * PRIVACY.md L64 の議事録単位オプトアウトを担保する。
 */
export function ExcludeFromLearningToggle({ minuteId, initialExcluded }: Props) {
  const [excluded, setExcluded] = useState(initialExcluded)
  const [saving, setSaving] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  async function handleToggle() {
    const next = !excluded
    setSaving(true)
    setErrorMsg(null)
    try {
      await updateMinute({ id: minuteId, excludeFromLearning: next })
      setExcluded(next)
    } catch {
      setErrorMsg('更新に失敗しました。少し時間を置いて再度お試しください。')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex items-center gap-2 text-xs text-gray-500">
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={excluded}
          onChange={handleToggle}
          disabled={saving}
          className="rounded border-gray-300"
        />
        この議事録を書き方の学習に使わない
      </label>
      {errorMsg && (
        <span className="text-red-600" role="alert">
          {errorMsg}
        </span>
      )}
    </div>
  )
}
