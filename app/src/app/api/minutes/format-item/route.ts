import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import {
  SYSTEM_PROMPT_FORMAT_ITEM,
  buildUserPromptFormatItem,
  buildCustomToneInstruction,
  TONE_INSTRUCTIONS,
} from '@/lib/ai/prompts/format-item'
import { formatSseErrorPayload } from '@/lib/api/error-response'
import {
  checkAiUsage,
  aiLimitExceededBody,
  logAiUsage,
  resolveFamilyIdByUser,
} from '@/lib/ai-usage-guard'
import { getClientIp } from '@/lib/client-ip'
import { recordGuestAiUsage } from '@/lib/guest-metrics'
import { guestAiGate } from '@/lib/guest-gate'

export const runtime = 'edge'

const requestSchema = z
  .object({
    field_name: z.string().min(1).max(100),
    raw_text: z.string().min(1).max(8000),
    tone: z.enum(['omakase', 'calm', 'polite', 'bright', 'custom']),
    custom_text: z.string().trim().min(1).max(200).optional(),
    turnstileToken: z.string().optional(),
  })
  .refine(
    (d) => d.tone !== 'custom' || (d.custom_text && d.custom_text.length > 0),
    { message: 'custom_text is required when tone is custom', path: ['custom_text'] },
  )

/**
 * POST /api/minutes/format-item
 * Body: { field_name, raw_text, tone }
 * Response: text/event-stream (Anthropic messages.stream() → SSE)
 *
 * Edge Runtime + Anthropic streaming で 2 秒以内に最初の token を返す目標。
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

  // Track whether this is a guest (unauthenticated) request. familyId is null for guests.
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
    // Guest passes: continue with familyId=null, skip ai_usage_log insert.
  } else {
    familyId = await resolveFamilyIdByUser(user.id)
  }

  // Authenticated path: 3-layer atomic usage check (family / user / global).
  // family_id is resolved via service role to bypass RLS (see ai-usage-guard.ts).
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
  const { tone, custom_text } = parsed.data
  const toneInstruction =
    tone === 'custom'
      ? buildCustomToneInstruction(custom_text!) // refine 通過済みなので非 null
      : TONE_INSTRUCTIONS[tone]

  const userPrompt = buildUserPromptFormatItem({
    fieldName: parsed.data.field_name,
    rawText: parsed.data.raw_text,
    toneInstruction,
  })

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      // 成功後 usage を best-effort で log INSERT する。
      // stream 内で usage を集計し、finally で log を追記 (失敗してもユーザー応答は成功扱い)。
      let inputTokens = 0
      let outputTokens = 0
      try {
        // SDK v0.32 系の TextBlockParam 型に cache_control が無いため any 化
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const params: any = {
          model,
          max_tokens: 1024,
          system: [
            {
              type: 'text',
              text: SYSTEM_PROMPT_FORMAT_ITEM,
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages: [{ role: 'user', content: userPrompt }],
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const anthropicStream = await (client.messages.stream as any)(params)

        for await (const event of anthropicStream) {
          if (
            event.type === 'content_block_delta' &&
            event.delta?.type === 'text_delta' &&
            typeof event.delta.text === 'string'
          ) {
            const data = JSON.stringify({ type: 'delta', text: event.delta.text })
            controller.enqueue(encoder.encode(`data: ${data}\n\n`))
          } else if (event.type === 'message_start' && event.message?.usage) {
            inputTokens = event.message.usage.input_tokens ?? 0
          } else if (event.type === 'message_delta' && event.usage) {
            outputTokens = event.usage.output_tokens ?? outputTokens
          }
        }

        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done' })}\n\n`))
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
          const cost =
            (inputTokens * 3 + outputTokens * 15) / 1_000_000
          void logAiUsage({
            familyId,
            userId: user.id,
            endpoint: 'format-item',
            inputTokens,
            outputTokens,
            costUsdEstimate: cost,
          })
        } else {
          // Best-effort guest usage metrics — failure must not affect the response.
          void recordGuestAiUsage({
            endpoint: 'format-item',
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
