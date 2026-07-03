'use client'

import { useEffect, useState } from 'react'
import {
  getStyleLearningState,
  regenerateStyleProfile,
  setStyleLearningEnabled,
  deleteStyleLearningData,
} from '@/server/style-profile'

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready'
      enabled: boolean
      hasProfile: boolean
      lastUpdatedAt: string | null
    }

/**
 * 設定画面の「議事録の書き方を覚える」セクション。
 * - 学習 ON/OFF（世帯単位）
 * - 手動再生成（「書き方を学習し直す」）
 * - 学習データ削除（PRIVACY.md L64 の削除権を担保）
 */
export function StyleLearningSection() {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [regenerating, setRegenerating] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    void (async () => {
      const res = await getStyleLearningState()
      if (!mounted) return
      if (!res.ok) {
        setState({
          status: 'error',
          message:
            res.code === 'UNAUTHENTICATED'
              ? '認証が切れています。再度ログインしてください。'
              : '家族に所属していません。',
        })
        return
      }
      setState({
        status: 'ready',
        enabled: res.enabled,
        hasProfile: res.hasProfile,
        lastUpdatedAt: res.lastUpdatedAt,
      })
    })()
    return () => {
      mounted = false
    }
  }, [])

  async function handleToggle() {
    if (state.status !== 'ready') return
    const next = !state.enabled
    setToggling(true)
    setMessage(null)
    try {
      const res = await setStyleLearningEnabled(next)
      if (res.ok) {
        setState({ ...state, enabled: next })
      } else {
        setMessage('更新に失敗しました。少し時間を置いて再度お試しください。')
      }
    } finally {
      setToggling(false)
    }
  }

  async function handleRegenerate() {
    setRegenerating(true)
    setMessage(null)
    try {
      const res = await regenerateStyleProfile()
      if (res.ok) {
        setMessage('書き方を学習し直しました。')
        const refreshed = await getStyleLearningState()
        if (refreshed.ok) {
          setState({
            status: 'ready',
            enabled: refreshed.enabled,
            hasProfile: refreshed.hasProfile,
            lastUpdatedAt: refreshed.lastUpdatedAt,
          })
        }
      } else if (res.skippedReason === 'NO_MINUTES') {
        setMessage('学習に使える議事録がまだ足りません（3件以上必要です）。')
      } else if (res.skippedReason === 'AI_LIMIT_EXCEEDED') {
        setMessage('本日のAI利用上限に達しています。時間を置いて再度お試しください。')
      } else {
        setMessage('学習し直しに失敗しました。少し時間を置いて再度お試しください。')
      }
    } catch {
      setMessage('学習し直しに失敗しました。少し時間を置いて再度お試しください。')
    } finally {
      setRegenerating(false)
    }
  }

  async function handleDelete() {
    if (!confirm('学習した書き方のデータを削除します。元に戻せません。')) return
    setDeleting(true)
    setMessage(null)
    try {
      const res = await deleteStyleLearningData()
      if (res.ok) {
        setMessage('学習データを削除しました。')
        if (state.status === 'ready') {
          setState({ ...state, hasProfile: false, lastUpdatedAt: null })
        }
      } else {
        setMessage('削除に失敗しました。少し時間を置いて再度お試しください。')
      }
    } finally {
      setDeleting(false)
    }
  }

  if (state.status === 'loading') {
    return <p className="text-xs text-gray-500">読み込み中…</p>
  }
  if (state.status === 'error') {
    return <p className="text-xs text-red-600">{state.message}</p>
  }

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={state.enabled}
          onChange={handleToggle}
          disabled={toggling}
          className="rounded border-gray-300"
        />
        この家庭の書き方を学習する
      </label>

      <p className="text-xs text-gray-500">
        {state.hasProfile
          ? `学習済み${state.lastUpdatedAt ? `（最終更新: ${new Date(state.lastUpdatedAt).toLocaleDateString('ja-JP')}）` : ''}`
          : 'まだ学習されていません（議事録が3件以上になると学習できます）'}
      </p>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleRegenerate}
          disabled={regenerating || !state.enabled}
          className="text-sm border border-gizirotto-blue-300 text-gizirotto-blue-700 px-3 py-2 rounded hover:bg-gizirotto-blue-50 disabled:opacity-50"
        >
          {regenerating ? '学習中…' : '書き方を学習し直す'}
        </button>
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleting || !state.hasProfile}
          className="text-sm border border-red-300 text-red-600 px-3 py-2 rounded hover:bg-red-50 disabled:opacity-50"
        >
          {deleting ? '削除中…' : '学習データを削除'}
        </button>
      </div>

      {message && (
        <p className="text-xs text-gizirotto-blue-700" role="status">
          {message}
        </p>
      )}
    </div>
  )
}
