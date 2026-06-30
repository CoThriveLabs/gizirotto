import 'server-only'

import { guestAiLimit } from '@/lib/ratelimit'
import { verifyTurnstile } from '@/lib/turnstile'

/**
 * Shared guest gate for AI endpoints (chat/stream and format-item).
 * Runs in order: Turnstile verification → guestAiLimit consumption.
 * The burst check is handled by middleware before the route is reached,
 * so it is not repeated here.
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

  // Consume one guest AI quota slot for this IP.
  const { success } = await guestAiLimit.limit(`ip:${args.ip}`)
  if (!success) {
    const next = encodeURIComponent(args.referer ?? '/')
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: 'AI_LIMIT_GUEST', loginUrl: `/login?next=${next}` }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ),
    }
  }

  return { ok: true }
}
