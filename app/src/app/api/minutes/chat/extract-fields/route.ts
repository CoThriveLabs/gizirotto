import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { getTemplate } from '@/server/templates'
import { isBuiltinTemplate } from '@/lib/templates/builtin-ids'
import { getClientIp } from '@/lib/client-ip'
import { guestAiGate } from '@/lib/guest-gate'
import {
  SYSTEM_PROMPT_CHAT_TO_FIELDS,
  buildChatToFieldsJsonSchema,
  buildChatToFieldsUserPrompt,
} from '@/lib/ai/prompts/chat-to-fields'

export const runtime = 'nodejs'
export const maxDuration = 30

const EXTRACT_TOOL_NAME = 'fill_minute_fields'

const messageRoleSchema = z.object({
  role: z.enum(['user', 'assistant']),
  // stream 由来の一時的な空 content 行を許容する（chat-sessions.ts の同名スキーマと同じ理由）。
  content: z.string().max(20000),
})

const requestSchema = z.object({
  templateId: z.string().uuid(),
  conversation: z.array(messageRoleSchema).min(1).max(100),
  turnstileToken: z.string().optional(),
})

/**
 * POST /api/minutes/chat/extract-fields
 *
 * Guest-only counterpart of the extractFieldsFromChat Server Action
 * (src/server/chat-sessions.ts). Logged-in users keep calling that Server Action
 * directly from ChatView; this route exists only so unauthenticated visitors can also
 * get AI field-binding instead of always falling back to the memo-dump path.
 *
 * fields are never trusted from the client — they are re-resolved server-side from
 * templateId on every call so a forged fields array cannot inflate the Anthropic
 * request size/cost.
 */
export async function POST(req: NextRequest) {
  // このルートはゲスト専用。ログイン済みセッションが来た場合は拒否する
  // （ChatView はログインユーザーではこの route を呼ばないが、多層防御として route 自身も確認する）。
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (user) {
    return jsonError('GUEST_ONLY', 403)
  }

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

  const ip = getClientIp(req)
  const gate = await guestAiGate({
    token: parsed.data.turnstileToken,
    ip,
    referer: req.headers.get('referer') ?? undefined,
  })
  if (!gate.ok) return gate.response

  // Guard against arbitrary family template access via RLS-bypassing service client
  // inside getTemplate (mirrors chat/stream route's same guard for the same reason).
  if (!isBuiltinTemplate(parsed.data.templateId)) {
    return jsonError('TEMPLATE_NOT_ALLOWED', 403)
  }

  const template = await getTemplate(parsed.data.templateId)
  const fields = extractFieldList(template.fields)
  // 空 fields で来た場合は AI を呼ばず空 values を返す（chat-sessions.ts の同分岐と同じ・cost 0）。
  if (fields.length === 0) {
    return NextResponse.json({ values: {} }, { status: 200 })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  const model = process.env.ANTHROPIC_MODEL
  if (!apiKey || !model) {
    return jsonError('AI_NOT_CONFIGURED', 500)
  }

  const client = new Anthropic({ apiKey })
  const userPrompt = buildChatToFieldsUserPrompt({
    fields,
    conversation: parsed.data.conversation,
  })
  const inputSchema = buildChatToFieldsJsonSchema({ fields })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any = {
    model,
    max_tokens: 2048,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT_CHAT_TO_FIELDS,
        cache_control: { type: 'ephemeral' },
      },
    ],
    tools: [
      {
        name: EXTRACT_TOOL_NAME,
        description:
          'Fill family meeting minute fields from the conversation history.',
        input_schema: inputSchema,
      },
    ],
    tool_choice: { type: 'tool', name: EXTRACT_TOOL_NAME },
    messages: [{ role: 'user', content: userPrompt }],
  }

  let response: { content: Array<{ type: string; name?: string; input?: unknown }> }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    response = await (client.messages.create as any)(params)
  } catch {
    return jsonError('AI_REQUEST_FAILED', 502)
  }

  const toolUse = response.content.find(
    (c) => c.type === 'tool_use' && c.name === EXTRACT_TOOL_NAME,
  )
  if (!toolUse || !toolUse.input || typeof toolUse.input !== 'object') {
    return jsonError('NO_TOOL_USE_BLOCK', 502)
  }
  const rawValues = (toolUse.input as { values?: unknown }).values
  if (!rawValues || typeof rawValues !== 'object') {
    return jsonError('NO_VALUES_OBJECT', 502)
  }

  const values: Record<string, string> = {}
  for (const f of fields) {
    const v = (rawValues as Record<string, unknown>)[f.name]
    values[f.name] = typeof v === 'string' ? v : ''
  }
  return NextResponse.json({ values }, { status: 200 })
}

function jsonError(code: string, status: number, detail?: unknown): NextResponse {
  return NextResponse.json(
    detail === undefined ? { error: code } : { error: code, detail },
    { status },
  )
}

/**
 * templates.fields は新形式 `{ fields: [...] }` と旧形式の配列直書き `[...]` の両方があるため
 * 両対応で正規化する（chat/stream route・(public-flow) chat page.tsx と同一ロジック）。
 */
function extractFieldList(raw: unknown): Array<{ name: string; label: string }> {
  if (!raw) return []
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
