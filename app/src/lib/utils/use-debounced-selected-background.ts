/**
 * 段階2-D3 案 D（v2.5 §1-2-6-2）: AdjustView の selected 切替時に
 * 「selected 以外焼き込み済」PNG を debounce 付きで fetch するための小さなカスタムフック。
 *
 * 純粋なロジック切出し（AdjustView 本体を fat にせず、unit テスト可能に）。
 *
 * 仕様:
 *   - selected === null → bgUrl を null にリセット（既存 rawBgUrl 経路へフォールバック）
 *   - selected !== null → debounce ms 経過後に POST /api/minutes/:id/render-image
 *     ({ raw:true, raw_except_selected: selected })
 *   - 連打時は最後の selected の fetch だけ走る（前の timer は clearTimeout で取消）
 *   - unmount or selected 変化時に cancelled フラグで stale state set を防ぐ
 */
'use client'
import { useEffect, useState } from 'react'

export interface UseDebouncedSelectedBackgroundOptions {
  minuteId: string
  selected: string | null
  /** debounce ms（既定 300） */
  debounceMs?: number
  /** test 用に注入可能 (default = globalThis.fetch) */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>
}

export function useDebouncedSelectedBackground({
  minuteId,
  selected,
  debounceMs = 300,
  fetchImpl,
}: UseDebouncedSelectedBackgroundOptions): string | null {
  const [bgUrl, setBgUrl] = useState<string | null>(null)

  useEffect(() => {
    if (selected === null) {
      setBgUrl(null)
      return
    }
    let cancelled = false
    const fetcher = fetchImpl ?? (globalThis.fetch as (input: string, init?: RequestInit) => Promise<Response>)
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetcher(`/api/minutes/${minuteId}/render-image`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify({
              dpi: 150,
              format: 'png',
              pageRange: { from: 1, to: 1 },
              raw: true,
              raw_except_selected: selected,
            }),
          })
          if (!res.ok) return
          const json = (await res.json()) as { signedUrl?: string }
          if (!cancelled && json.signedUrl) setBgUrl(json.signedUrl)
        } catch {
          // サイレント fallback（既存 rawBgUrl が引き続き使われる）
        }
      })()
    }, debounceMs)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [selected, minuteId, debounceMs, fetchImpl])

  return bgUrl
}
