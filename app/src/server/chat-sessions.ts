'use server'

import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { decodeAccessTokenClaims } from '@/lib/jwt-claims'
import {
  SYSTEM_PROMPT_CHAT_TO_FIELDS,
  buildChatToFieldsJsonSchema,
  buildChatToFieldsUserPrompt,
  normalizeMeetingDate,
} from '@/lib/ai/prompts/chat-to-fields'

/**
 * AI チャット (A-1 / A-2) のセッション管理 Server Action。
 *
 * - createChatSession: chat_sessions INSERT、id を client に返す
 * - persistChatTurn: stream 完了時に user + assistant メッセージを batch INSERT
 * - completeChatSession: chat_sessions.completed_at を更新（議事録保存後）
 *
 * stream 中の partial write は性能影響あるため完了時 batch に書き込む。
 */

const modeSchema = z.enum(['A-1', 'A-2'])

const createSessionSchema = z.object({
  templateId: z.string().uuid(),
  mode: modeSchema,
})

const persistTurnSchema = z.object({
  sessionId: z.string().uuid(),
  userMessage: z.string().min(1).max(8000),
  assistantMessage: z.string().min(1).max(20000),
})

const completeSessionSchema = z.object({
  sessionId: z.string().uuid(),
})

export type ChatMode = z.infer<typeof modeSchema>

/**
 * chat_sessions 新規作成。初回 user 発言の前に呼ばれる。
 * family_id は JWT claims から取得（middleware で検証済 + RLS 二重防御）。
 */
export async function createChatSession(input: {
  templateId: string
  mode: ChatMode
}): Promise<{ id: string }> {
  const parsed = createSessionSchema.parse(input)
  const supabase = await createSupabaseServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('UNAUTHENTICATED')

  const { data: sessionData } = await supabase.auth.getSession()
  const familyId = decodeAccessTokenClaims(sessionData.session?.access_token)?.family_id
  if (!familyId) throw new Error('NOT_IN_FAMILY')

  const { data, error } = await supabase
    .from('chat_sessions')
    .insert({
      family_id: familyId,
      template_id: parsed.templateId,
      mode: parsed.mode,
      created_by: user.id,
    })
    .select('id')
    .single()
  if (error) throw error
  return { id: data.id }
}

/**
 * stream 完了時に 1 ターン分（user + assistant）を batch INSERT。
 * order は created_at で保証（同 timestamptz 内は INSERT 順）。
 */
export async function persistChatTurn(input: {
  sessionId: string
  userMessage: string
  assistantMessage: string
}): Promise<{ ok: true }> {
  const parsed = persistTurnSchema.parse(input)
  const supabase = await createSupabaseServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('UNAUTHENTICATED')

  const { error } = await supabase.from('messages').insert([
    {
      session_id: parsed.sessionId,
      role: 'user',
      content: parsed.userMessage,
    },
    {
      session_id: parsed.sessionId,
      role: 'assistant',
      content: parsed.assistantMessage,
    },
  ])
  if (error) throw error
  return { ok: true }
}

/**
 * chat_sessions.completed_at を更新（議事録保存後の cleanup）。
 * minute_id へのリンクは createMinute() 側で別途行う想定（schema 上 SET NULL）。
 */
export async function completeChatSession(input: {
  sessionId: string
}): Promise<{ ok: true }> {
  const parsed = completeSessionSchema.parse(input)
  const supabase = await createSupabaseServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('UNAUTHENTICATED')

  const { error } = await supabase
    .from('chat_sessions')
    .update({ completed_at: new Date().toISOString() })
    .eq('id', parsed.sessionId)
  if (error) throw error
  return { ok: true }
}

const EXTRACT_TOOL_NAME = 'fill_minute_fields'

const fieldDefSchema = z.object({
  name: z.string().min(1).max(100),
  label: z.string().min(1).max(200),
})

const messageRoleSchema = z.object({
  role: z.enum(['user', 'assistant']),
  // stream 中に setMessages で空 content のプレースホルダ assistant 行が入る瞬間があり、
  // onFinalize がそれを掴むと .min(1) 違反になる。stream 由来の内部データなので空文字を許容する。
  content: z.string().max(20000),
})

const extractFieldsSchema = z.object({
  // 空 fields は早期 return で空 values を返し、ChatView の extractFailed=true 経路と整合。
  fields: z.array(fieldDefSchema).max(50),
  conversation: z.array(messageRoleSchema).min(1).max(100),
})

/**
 * 会話履歴から各 field name にバインドした values を抽出。
 * tool_use 強制で構造化 JSON を確実取得、失敗時は呼出側で fallback。
 * 人間チェックフローと連動: ここで自動振分けした結果を confirm 画面で人が編集。
 */
export async function extractFieldsFromChat(input: {
  fields: Array<{ name: string; label: string }>
  conversation: Array<{ role: 'user' | 'assistant'; content: string }>
}): Promise<{ values: Record<string, string>; meetingDate?: string }> {
  const parsed = extractFieldsSchema.parse(input)
  // 空 fields で来た場合は AI を呼ばず空 values を返す（cost 0・zod .min(1) 早期 return）。
  if (parsed.fields.length === 0) return { values: {} }
  const supabase = await createSupabaseServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('UNAUTHENTICATED')

  const apiKey = process.env.ANTHROPIC_API_KEY
  const model = process.env.ANTHROPIC_MODEL
  if (!apiKey || !model) throw new Error('AI_NOT_CONFIGURED')

  const client = new Anthropic({ apiKey })
  const userPrompt = buildChatToFieldsUserPrompt({
    fields: parsed.fields,
    conversation: parsed.conversation,
  })
  const inputSchema = buildChatToFieldsJsonSchema({ fields: parsed.fields })

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response = await (client.messages.create as any)(params)

  const toolUse = (
    response.content as Array<{ type: string; name?: string; input?: unknown }>
  ).find((c) => c.type === 'tool_use' && c.name === EXTRACT_TOOL_NAME)
  if (!toolUse || !toolUse.input || typeof toolUse.input !== 'object') {
    throw new Error('NO_TOOL_USE_BLOCK')
  }
  const rawValues = (toolUse.input as { values?: unknown }).values
  if (!rawValues || typeof rawValues !== 'object') {
    throw new Error('NO_VALUES_OBJECT')
  }

  const values: Record<string, string> = {}
  for (const f of parsed.fields) {
    const v = (rawValues as Record<string, unknown>)[f.name]
    values[f.name] = typeof v === 'string' ? v : ''
  }
  // 会話で開催日が絶対日付として明示された場合のみ meetingDate を返す（ゲスト route と同一ロジック）。
  const meetingDate = normalizeMeetingDate(
    (toolUse.input as { meeting_date?: unknown }).meeting_date,
  )
  return meetingDate !== undefined ? { values, meetingDate } : { values }
}
