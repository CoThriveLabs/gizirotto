'use client'

/**
 * Cloudflare Turnstile invisible widget。
 *
 * クライアント専用。public site key のみ参照 (secret はサーバ側 turnstile.ts)。
 * site key 未設定 (ローカル) では widget を描画せず、トークン未取得でも
 * サーバ側 verifyTurnstile が skip するため login は通る。
 *
 * ref API: forwardRef + useImperativeHandle で reset() を露出する。react-turnstile の
 * onVerify / onError コールバック 2 番目の引数として渡ってくる BoundTurnstileObject
 * （`{ reset, execute, getResponse, isExpired }`）を捕まえておき、外部から呼べるようにする。
 * 使い捨てトークンを使い切ったあと、次回チャレンジを明示的に発火するのに使う。
 *
 * ref 未指定でも動く（既存 login/page.tsx や templates upload-form は ref を渡さない）。
 */

import { forwardRef, useImperativeHandle, useRef } from 'react'
import Turnstile from 'react-turnstile'

export interface TurnstileWidgetRef {
  /** 内部 challenge を再発火する。widget 未 mount / site key 未設定時は no-op。 */
  reset: () => void
}

interface Props {
  onToken: (t: string) => void
}

export const TurnstileWidget = forwardRef<TurnstileWidgetRef, Props>(function TurnstileWidget(
  { onToken },
  ref,
) {
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY
  const boundRef = useRef<{ reset: () => void } | null>(null)

  useImperativeHandle(
    ref,
    () => ({
      reset: () => {
        boundRef.current?.reset()
      },
    }),
    [],
  )

  if (!siteKey) return null
  return (
    <Turnstile
      sitekey={siteKey}
      appearance="execute"
      execution="render"
      onVerify={(t, bound) => {
        boundRef.current = bound
        onToken(t)
      }}
      onError={(_e, bound) => {
        if (bound) boundRef.current = bound
        onToken('')
      }}
      onExpire={(_t, bound) => {
        boundRef.current = bound
        onToken('')
      }}
    />
  )
})
