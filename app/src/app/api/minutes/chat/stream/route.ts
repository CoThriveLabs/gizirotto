import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import {
  SYSTEM_PROMPT_CHAT_A1,
  buildSystemA1Suffix,
} from '@/lib/ai/prompts/chat-a1'
import {
  SYSTEM_PROMPT_CHAT_A2,
  buildSystemA2Suffix,
} from '@/lib/ai/prompts/chat-a2'
import { formatSseErrorPayload } from '@/lib/api/error-response'
import {
  checkAiUsage,
  aiLimitExceededBody,
  logAiUsage,
  resolveFamilyIdByUser,
} from '@/lib/ai-usage-guard'
import { createSupabaseServiceClient } from '@/lib/supabase/service'
import { getClientIp } from '@/lib/client-ip'
import { recordGuestAiUsage } from '@/lib/guest-metrics'
import { isBuiltinTemplate } from '@/lib/templates/builtin-ids'
import { guestAiGate } from '@/lib/guest-gate'
import { fetchStyleSummary } from '@/lib/ai/style/fetch-style-summary'
import { asStyleDb } from '@/lib/ai/style/style-db-types'

export const runtime = 'edge'

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(20000),
})

const requestSchema = z.object({
  session_id: z.string().uuid(),
  mode: z.enum(['A-1', 'A-2']),
  template_id: z.string().uuid(),
  history: z.array(messageSchema).max(50),
  latest_user_message: z.string().min(1).max(8000),
  turnstileToken: z.string().optional(),
})

/**
 * POST /api/minutes/chat/stream
 * A-1 質問順 / A-2 自由会話 用の Anthropic streaming proxy。
 * Body: { session_id, mode, template_id, history, latest_user_message }
 * Response: text/event-stream
 *
 * Edge Runtime + SSE で開始 2 秒以内目標。
 * chat_sessions / messages の DB 書込は stream 完了後に client → Server Action 経由で別途実施。
 */
export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // Parse body first so Turnstile token is available before consuming quota.
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return jsonError('INVALID_JSON', 400)
  }
  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) {
    return jsonError('INVALID_REQUEST', 400, parsed.error.flatten())
  }

  // Track familyId; null for guests so ai_usage_log insert is skipped.
  let familyId: string | null = null
  // Resolve IP at handler scope so both guest metrics and the rate-limiter share the same value.
  const ip = getClientIp(req)

  if (!user) {
    const gate = await guestAiGate({
      token: parsed.data.turnstileToken,
      ip,
      referer: req.headers.get('referer') ?? undefined,
    })
    if (!gate.ok) return gate.response

    // Guard against arbitrary family template access via RLS-bypassing service client.
    // service client bypasses RLS; safe only because the guest path is gated to builtin templates here.
    if (!isBuiltinTemplate(parsed.data.template_id)) {
      return jsonError('TEMPLATE_NOT_ALLOWED', 403)
    }
    // Guest passes: continue with familyId=null.
  } else {
    familyId = await resolveFamilyIdByUser(user.id)
  }

  // Fetch template fields. Guests can only reach builtin templates (enforced at page level),
  // so use service client here to bypass RLS for unauthenticated requests.
  const templateClient = user ? supabase : createSupabaseServiceClient()
  const { data: tpl, error: tplError } = await templateClient
    .from('templates')
    .select('fields')
    .eq('id', parsed.data.template_id)
    .maybeSingle()
  if (tplError || !tpl) {
    return jsonError('TEMPLATE_NOT_FOUND', 404)
  }
  const templateFields = extractFieldList(tpl.fields)
  if (templateFields.length === 0) {
    return jsonError('TEMPLATE_HAS_NO_FIELDS', 400)
  }

  // 家庭スタイルプロファイルの取得は best-effort。未生成・取得失敗・学習 OFF は
  // null のまま従来挙動（suffix にスタイルブロックが乗らない）にフォールバックする。
  const styleSummary = familyId
    ? await fetchStyleSummary(asStyleDb(supabase), familyId)
    : null

  // Authenticated path: 3-layer atomic usage check (family / user / global).
  if (user) {
    const usageCheck = await checkAiUsage({ familyId, userId: user.id })
    if (usageCheck.exceeded) {
      return new Response(JSON.stringify(aiLimitExceededBody(usageCheck)), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      })
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  const model = process.env.ANTHROPIC_MODEL
  if (!apiKey || !model) {
    return jsonError('AI_NOT_CONFIGURED', 500)
  }

  const client = new Anthropic({ apiKey })
  const systemBase =
    parsed.data.mode === 'A-1' ? SYSTEM_PROMPT_CHAT_A1 : SYSTEM_PROMPT_CHAT_A2
  const systemSuffix =
    parsed.data.mode === 'A-1'
      ? buildSystemA1Suffix({ templateFields, styleSummary })
      : buildSystemA2Suffix({ templateFields, styleSummary })

  const messages = [
    ...parsed.data.history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: parsed.data.latest_user_message },
  ]

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      // usage を集計 → finally で log INSERT (best-effort)
      let inputTokens = 0
      let outputTokens = 0
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const params: any = {
          model,
          max_tokens: 2048,
          system: [
            {
              type: 'text',
              text: systemBase,
              cache_control: { type: 'ephemeral' },
            },
            {
              type: 'text',
              text: systemSuffix,
            },
          ],
          messages,
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const anthropicStream = await (client.messages.stream as any)(params)
        for await (const event of anthropicStream) {
          if (
            event.type === 'content_block_delta' &&
            event.delta?.type === 'text_delta' &&
            typeof event.delta.text === 'string'
          ) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: 'delta', text: event.delta.text })}\n\n`,
              ),
            )
          } else if (event.type === 'message_start' && event.message?.usage) {
            inputTokens = event.message.usage.input_tokens ?? 0
          } else if (event.type === 'message_delta' && event.usage) {
            outputTokens = event.usage.output_tokens ?? outputTokens
          }
        }
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: 'done' })}\n\n`),
        )
      } catch (err) {
        // 本番で err.message を SSE に流さないようヘルパー経由で本番マスク。
        const payload = formatSseErrorPayload(err)
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify(payload)}\n\n`,
          ),
        )
      } finally {
        controller.close()
        // ai_usage_log INSERT (best-effort). Skip for guests (familyId is null).
        // Claude Haiku 3.5 estimate: input $3 / output $15 per 1M tokens.
        if (familyId && user) {
          const cost = (inputTokens * 3 + outputTokens * 15) / 1_000_000
          void logAiUsage({
            familyId,
            userId: user.id,
            endpoint: 'chat-stream',
            inputTokens,
            outputTokens,
            costUsdEstimate: cost,
          })
        } else {
          // Best-effort guest usage metrics — failure must not affect the response.
          void recordGuestAiUsage({
            endpoint: 'chat-stream',
            inputTokens,
            outputTokens,
          })
        }
      }
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}

function jsonError(code: string, status: number, detail?: unknown): Response {
  return new Response(
    JSON.stringify(detail === undefined ? { error: code } : { error: code, detail }),
    { status, headers: { 'content-type': 'application/json' } },
  )
}

function extractFieldList(raw: unknown): Array<{ name: string; label: string }> {
  if (!raw) return []
  // templates.fields は新形式 `{ fields: [...] }` だが、
  // 旧形式の配列直書き `[...]` で保存されている個体があり、両方受ける。
  const arr: unknown = Array.isArray(raw)
    ? raw
    : typeof raw === 'object'
      ? (raw as { fields?: unknown }).fields
      : null
  if (!Array.isArray(arr)) return []
  return arr
    .map((f) => {
      if (!f || typeof f !== 'object') return null
      const obj = f as Record<string, unknown>
      const name = typeof obj.name === 'string' ? obj.name : null
      if (!name) return null
      const label =
        typeof obj.label_ja === 'string'
          ? obj.label_ja
          : typeof obj.label === 'string'
            ? obj.label
            : name
      return { name, label }
    })
    .filter((v): v is { name: string; label: string } => v !== null)
}
