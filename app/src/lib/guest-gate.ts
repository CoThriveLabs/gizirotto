import 'server-only'

import { guestAiDailyLimit } from '@/lib/ratelimit'
import { verifyTurnstile } from '@/lib/turnstile'

/**
 * Shared guest gate for AI endpoints (chat/stream, format-item, extract-fields).
 * Runs in order: Turnstile verification → guestAiDailyLimit consumption.
 * The burst check is handled by middleware before the route is reached,
 * so it is not repeated here.
 *
 * guestAiDailyLimit は「議事録 2 件制限」ではなく AI 呼び出し暴発防御専用（DoS 対策）。
 * 到達しても**ログイン誘導ではなく 429 Too Many Requests を返す**（時間経過で自動復帰）。
 * 「議事録 2 件制限」は guestTemplateLimit（AdjustView 到達時消費）で別途担保する。
 *
 * Returns { ok: true } when the guest passes all checks.
 * Returns { ok: false, response } with a ready-to-return Response on failure.
 * The caller is responsible for the isBuiltinTemplate guard (template-specific, not shared here).
 */
export async function guestAiGate(args: {
  token: string | undefined
  ip: string
  referer?: string
}): Promise<{ ok: true } | { ok: false; response: Response }> {
  // Verify Turnstile before consuming quota so a bad token never burns a slot.
  const v = await verifyTurnstile(args.token ?? '', args.ip)
  if (!v.ok) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: 'TURNSTILE_FAILED' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    }
  }

  // Consume one guest AI daily quota slot for this IP.
  const { success, reset } = await guestAiDailyLimit.limit(`ip:${args.ip}`)
  if (!success) {
    // Retry-After は seconds 単位で最小 1（ratelimit の reset が過去に見える場合の防御）。
    const retryAfterSec = Math.max(1, Math.ceil((reset - Date.now()) / 1000))
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: 'GUEST_AI_DAILY_LIMIT' }),
        {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'Retry-After': String(retryAfterSec),
          },
        },
      ),
    }
  }

  return { ok: true }
}
