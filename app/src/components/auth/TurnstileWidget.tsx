'use client'

/**
 * Cloudflare Turnstile invisible widget。
 *
 * クライアント専用。public site key のみ参照 (secret はサーバ側 turnstile.ts)。
 * site key 未設定 (ローカル) では widget を描画せず、トークン未取得でも
 * サーバ側 verifyTurnstile が skip するため login は通る。
 */

import Turnstile from 'react-turnstile'

export function TurnstileWidget({ onToken }: { onToken: (t: string) => void }) {
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY
  if (!siteKey) return null
  return (
    <Turnstile
      sitekey={siteKey}
      appearance="execute"
      execution="render"
      onVerify={(t) => onToken(t)}
      onError={() => onToken('')}
      onExpire={() => onToken('')}
    />
  )
}
