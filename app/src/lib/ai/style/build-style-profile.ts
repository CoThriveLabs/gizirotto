import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import {
  SYSTEM_PROMPT_STYLE_PROFILE,
  STYLE_PROFILE_TOOL_NAME,
  STYLE_PROFILE_JSON_SCHEMA,
  buildStyleProfileUserPrompt,
  type PastMinuteForStyle,
} from '@/lib/ai/prompts/style-profile'

/**
 * 家庭スタイルプロファイル生成の純粋ロジック。
 *
 * 過去 minutes 取得 → Anthropic tool_use → zod 検証 → user_styles upsert までを担う。
 * DB クライアントは呼出側から注入する（route/server action 側で通常クライアントか
 * service クライアントかを選ぶ・このファイルはどちらが来ても動く最小インタフェースのみ使う）。
 */

export const STYLE_PROFILE_VERSION = 1
export const STYLE_MIN_MINUTES = 3
export const STYLE_SOURCE_LIMIT = 5

const styleProfileSchema = z.object({
  version: z.literal(STYLE_PROFILE_VERSION).optional().default(STYLE_PROFILE_VERSION),
  tone: z.object({
    sentence_ending: z.string(),
    politeness: z.string(),
    register: z.string(),
  }),
  vocabulary: z.array(z.string()).max(15),
  field_order_hint: z.array(z.string()),
  formatting: z.object({
    bullet_preference: z.string(),
    paragraph_style: z.string(),
  }),
  summary_text: z.string().min(1),
})

export type StyleProfile = z.infer<typeof styleProfileSchema>

export interface BuildStyleProfileResult {
  ok: boolean
  skippedReason?:
    | 'NO_MINUTES'
    | 'EMPTY_CONTENT'
    | 'AI_REQUEST_FAILED'
    | 'NO_TOOL_USE_BLOCK'
    | 'INVALID_PROFILE_JSON'
    | 'UPSERT_FAILED'
  profile?: StyleProfile
  usage?: {
    inputTokens: number
    outputTokens: number
  }
}

interface MinutesRow {
  id: string
  meeting_date: string
  content_json: unknown
}

/**
 * Supabase クライアントに必要な最小限のメソッドだけを型で表現する。
 * 実クライアントの型は route/action 側の責務なので、ここでは DI しやすい形に絞る。
 */
export interface StyleProfileDb {
  from(table: string): {
    select: (columns: string) => {
      eq: (
        col: string,
        val: string,
      ) => {
        eq: (
          col: string,
          val: boolean,
        ) => {
          order: (
            col: string,
            opts: { ascending: boolean },
          ) => {
            limit: (n: number) => Promise<{ data: MinutesRow[] | null; error: { message: string } | null }>
          }
        }
      }
    }
    upsert: (
      values: Record<string, unknown>,
      opts: { onConflict: string },
    ) => Promise<{ error: { message: string } | null }>
  }
}

/**
 * content_json が Record<string, unknown> として扱える形かどうかを確認する。
 * 不正な形（配列・null・非オブジェクト）は空オブジェクト扱いにして落とさない。
 */
function normalizeContentJson(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return raw as Record<string, unknown>
}

/**
 * family の過去 minutes（exclude_from_learning=false・直近 N 件）から
 * スタイルプロファイルを生成し、user_styles に upsert する。
 *
 * 議事録 0 件 / 全件 content_json 空 / AI 不正応答のいずれでも例外を投げず、
 * ok:false + skippedReason を返して呼出側の処理を継続させる（設計書 §9 異常系方針）。
 */
export async function buildStyleProfile(args: {
  db: StyleProfileDb
  familyId: string
  anthropicApiKey: string
  anthropicModel: string
  minMinutes?: number
  sourceLimit?: number
}): Promise<BuildStyleProfileResult> {
  const minMinutes = args.minMinutes ?? STYLE_MIN_MINUTES
  const sourceLimit = args.sourceLimit ?? STYLE_SOURCE_LIMIT

  const { data: minutesRows, error: fetchError } = await args.db
    .from('minutes')
    .select('id, meeting_date, content_json')
    .eq('family_id', args.familyId)
    .eq('exclude_from_learning', false)
    .order('meeting_date', { ascending: false })
    .limit(sourceLimit)

  if (fetchError) {
    return { ok: false, skippedReason: 'NO_MINUTES' }
  }
  const rows = minutesRows ?? []
  if (rows.length < minMinutes) {
    return { ok: false, skippedReason: 'NO_MINUTES' }
  }

  const pastMinutes: PastMinuteForStyle[] = rows.map((r) => ({
    meetingDate: r.meeting_date,
    contentJson: normalizeContentJson(r.content_json),
  }))

  const hasAnyContent = pastMinutes.some(
    (m) => Object.keys(m.contentJson).length > 0,
  )
  if (!hasAnyContent) {
    return { ok: false, skippedReason: 'EMPTY_CONTENT' }
  }

  const client = new Anthropic({ apiKey: args.anthropicApiKey })
  const userPrompt = buildStyleProfileUserPrompt({ pastMinutes })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any = {
    model: args.anthropicModel,
    max_tokens: 1024,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT_STYLE_PROFILE,
        cache_control: { type: 'ephemeral' },
      },
    ],
    tools: [
      {
        name: STYLE_PROFILE_TOOL_NAME,
        description:
          'Extract this family style profile (tone, vocabulary, formatting habits) from past minutes.',
        input_schema: STYLE_PROFILE_JSON_SCHEMA,
      },
    ],
    tool_choice: { type: 'tool', name: STYLE_PROFILE_TOOL_NAME },
    messages: [{ role: 'user', content: userPrompt }],
  }

  let response: {
    content: Array<{ type: string; name?: string; input?: unknown }>
    usage: { input_tokens: number; output_tokens: number }
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    response = await (client.messages.create as any)(params)
  } catch {
    return { ok: false, skippedReason: 'AI_REQUEST_FAILED' }
  }

  const usage = {
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  }

  const toolUse = response.content.find(
    (c) => c.type === 'tool_use' && c.name === STYLE_PROFILE_TOOL_NAME,
  )
  if (!toolUse || !toolUse.input || typeof toolUse.input !== 'object') {
    return { ok: false, skippedReason: 'NO_TOOL_USE_BLOCK', usage }
  }

  const validated = styleProfileSchema.safeParse(toolUse.input)
  if (!validated.success) {
    return { ok: false, skippedReason: 'INVALID_PROFILE_JSON', usage }
  }

  const { error: upsertError } = await args.db.from('user_styles').upsert(
    {
      family_id: args.familyId,
      profile: validated.data,
      source_minutes_ids: rows.map((r) => r.id),
      last_updated_at: new Date().toISOString(),
    },
    { onConflict: 'family_id' },
  )
  if (upsertError) {
    return { ok: false, skippedReason: 'UPSERT_FAILED', usage }
  }

  return { ok: true, profile: validated.data, usage }
}
