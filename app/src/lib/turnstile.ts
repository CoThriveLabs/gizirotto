/**
 * Cloudflare Turnstile サーバ siteverify。
 *
 * サーバ専用 (TURNSTILE_SECRET_KEY を使う)。クライアントから import しないこと。
 * env (TURNSTILE_SECRET_KEY) 未設定環境 (ローカル) では検証 skip し既存挙動を保つ
 * (本番のみ必須)。
 */

import 'server-only'

export interface TurnstileResult {
  ok: boolean
  reason?: string
}

export async function verifyTurnstile(
  token: string,
  ip?: string,
): Promise<TurnstileResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY
  if (!secret) return { ok: true, reason: 'skipped_no_secret' }

  if (!token) return { ok: false, reason: 'no_token' }

  const res = await fetch(
    'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    {
      method: 'POST',
      body: new URLSearchParams({
        secret,
        response: token,
        ...(ip ? { remoteip: ip } : {}),
      }),
    },
  )
  const data = (await res.json()) as {
    success: boolean
    'error-codes'?: string[]
  }
  return { ok: data.success, reason: data['error-codes']?.[0] }
}
