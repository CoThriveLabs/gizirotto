'use client'

import { useEffect, useState, useCallback } from 'react'

/**
 * 家族使用量 polling hook。
 *
 * SWR は未導入のため、自前 useEffect + setInterval で軽量実装する（依存追加を避ける）。
 *
 * - 初回マウントで fetch
 * - 60 秒ごとに refresh (refreshInterval 相当)
 * - ページ非表示中は polling 停止 (Page Visibility API・無駄なリクエスト削減)
 * - 失敗時は前回値を保持 (再試行は次の interval で)
 */

export type UsageSlot = { used: number; cap: number }

export interface FamilyUsage {
  ai: UsageSlot
  minutes: UsageSlot
  templates: UsageSlot
}

interface State {
  data: FamilyUsage | null
  loading: boolean
  error: string | null
}

const REFRESH_INTERVAL_MS = 60_000

export function useFamilyUsage(): State & { refresh: () => Promise<void> } {
  const [state, setState] = useState<State>({
    data: null,
    loading: true,
    error: null,
  })

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/family/usage', {
        cache: 'no-store',
        credentials: 'same-origin',
      })
      if (!res.ok) {
        // 401 (未ログイン) / 404 (家族未所属) は data=null のまま loading 解除
        setState((prev) => ({
          data: prev.data,
          loading: false,
          error: `HTTP_${res.status}`,
        }))
        return
      }
      const data = (await res.json()) as FamilyUsage
      setState({ data, loading: false, error: null })
    } catch (e) {
      setState((prev) => ({
        data: prev.data,
        loading: false,
        error: e instanceof Error ? e.message : 'fetch_error',
      }))
    }
  }, [])

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null

    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return
      void refresh()
    }

    // 初回 fetch
    void refresh()
    intervalId = setInterval(tick, REFRESH_INTERVAL_MS)

    // タブ可視化復帰時に即 refresh (古い表示を避ける)
    const onVisibilityChange = () => {
      if (typeof document !== 'undefined' && !document.hidden) {
        void refresh()
      }
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange)
    }

    return () => {
      if (intervalId) clearInterval(intervalId)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange)
      }
    }
  }, [refresh])

  return { ...state, refresh }
}
