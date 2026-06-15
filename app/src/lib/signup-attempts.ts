/**
 * signup_attempts への記録ヘルパ。
 *
 * サーバ専用 (service role client を使う)。クライアントから import しないこと。
 * best-effort: 記録失敗が認証フローを止めないよう飲み込む。
 */

import 'server-only'
import { createSupabaseServiceClient } from '@/lib/supabase/service'

export async function recordSignupAttempt(params: {
  ip?: string | null
  emailDomain?: string | null
}): Promise<void> {
  try {
    const svc = createSupabaseServiceClient()
    await svc.from('signup_attempts').insert({
      ip: params.ip ?? null,
      email_domain: params.emailDomain ?? null,
    })
  } catch (e) {
    console.warn('[signup-attempts] insert failed', e)
  }
}
