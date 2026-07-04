'use client'

import { useCallback, useRef, useState } from 'react'

/**
 * ゲストの Turnstile トークン取得を中央化する hook。
 *
 * Cloudflare Turnstile はウィジェット mount → challenge 完了 → onVerify(token) が
 * 非同期でしか届かない。ChatView の初回 kick-off や AdjustView の整形ボタン等、
 * トークン到着より先に発火し得る送信経路は、この hook が返す consumeToken() を
 * await することでトークン到着まで待機できる。
 *
 * 使い捨て設計:
 *   - consumeToken() は resolve と同時に内部 state を空にリセット（次回チャレンジを促す）
 *   - onToken(t) は TurnstileWidget の onVerify にそのまま渡す
 *   - トークンが既にあれば consumeToken() は即 resolve（await 0-tick）
 *   - onError / onExpire は onToken('') を呼ぶ運用で、待機中の waiter は空文字で resolve される。
 *     呼び出し側は空トークンをサーバへ送るとサーバ側で TURNSTILE_FAILED になり、通常の
 *     エラーフローで拾える（ハングは絶対に起こさない）。
 *
 * enabled=false（ログイン済み）の場合は consumeToken() は即 undefined を resolve し、
 * 呼び出し側は token を body に含めないことでログインユーザー経路完全不変を保つ。
 *
 * reset() は TurnstileWidget の内部 challenge を再発火させる。fetch 失敗時に呼ぶことで、
 * 次回送信で新しいトークンが取れるようにする。widget が接続されていないタイミング
 * （site key 未設定・enabled=false）では no-op。
 *
 * Gotcha: 同時複数 waiter は禁止。使い捨てトークンを FIFO キューで捌くと 2 つ目の waiter が
 * 古いトークンを掴んで 403 になる。呼び出し側は既存の streaming/formatting flag 等で
 * 逐次化する責務を持つ。
 */
export interface UseGuestTurnstileGate {
  /** TurnstileWidget の onToken に渡す。onVerify で token、onError/onExpire で '' が届く。 */
  onToken: (t: string) => void
  /** 送信直前に await する。enabled=false なら undefined を即 resolve。 */
  consumeToken: () => Promise<string | undefined>
  /** TurnstileWidget の内部 challenge を再発火（bound object の reset を叩く）。 */
  reset: () => void
  /** TurnstileWidget が onLoad / onVerify で通知してきた bound object を受け取る。 */
  bindWidget: (widget: { reset: () => void } | null) => void
}

export function useGuestTurnstileGate(enabled: boolean): UseGuestTurnstileGate {
  const [token, setToken] = useState<string>('')
  const waiterRef = useRef<((t: string) => void) | null>(null)
  const widgetRef = useRef<{ reset: () => void } | null>(null)

  const onToken = useCallback((t: string) => {
    if (waiterRef.current) {
      const resolve = waiterRef.current
      waiterRef.current = null
      resolve(t)
      return
    }
    setToken(t)
  }, [])

  const consumeToken = useCallback((): Promise<string | undefined> => {
    if (!enabled) return Promise.resolve(undefined)
    if (token) {
      const captured = token
      setToken('')
      return Promise.resolve(captured)
    }
    return new Promise<string>((resolve) => {
      waiterRef.current = resolve
    })
  }, [enabled, token])

  const reset = useCallback(() => {
    // widget 未接続時（site key 未設定・enabled=false）は no-op。
    widgetRef.current?.reset()
  }, [])

  const bindWidget = useCallback((widget: { reset: () => void } | null) => {
    widgetRef.current = widget
  }, [])

  return { onToken, consumeToken, reset, bindWidget }
}
