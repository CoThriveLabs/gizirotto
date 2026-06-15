/**
 * AI route 共通: 3 階層 atomic check + 使用量 log。
 * `ai_usage_exceeded` RPC + `ai_usage_log` INSERT を service role で行う。
 *
 * このファイルはサーバ専用 (service role client を扱う)。クライアントから import 禁止。
 * Edge runtime と Node.js runtime の両方から呼ぶため、import を edge 互換に限定する。
 */

import 'server-only'
import { createSupabaseServiceClient } from '@/lib/supabase/service'

export type LimitScope = 'family' | 'user' | 'global' | 'unknown'

export interface CheckResult {
  exceeded: boolean
  scope?: LimitScope
  reset_at?: string
  reason?: string
}

/**
 * ai_usage_exceeded RPC を service role で叩く。
 * - RPC は jsonb を返す。失敗時 (rpcErr) は { exceeded: true, reason: 'rpc_error' } として
 *   ブロックする側に倒す (公開後の暴走課金を防ぐ・安全側)。
 * - p_family_id, p_user_id のどちらかが空文字/null の場合は呼ぶ前に弾く。
 */
export async function checkAiUsage(params: {
  familyId: string | null | undefined
  userId: string | null | undefined
}): Promise<CheckResult> {
  const { familyId, userId } = params
  if (!familyId || !userId) {
    return { exceeded: true, scope: 'unknown', reason: 'missing_ids' }
  }

  const svc = createSupabaseServiceClient()
  // ai_usage_exceeded / ai_usage_log は migration 適用後に存在するが、
  // database.types.ts (自動生成) 再生成タイミングまでは型に無いため any で逃がす。
  // pnpm types:gen 後に正式型が生え次第、any を外す。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (svc as any).rpc('ai_usage_exceeded', {
    p_family_id: familyId,
    p_user_id: userId,
  })

  if (error) {
    // 安全側: RPC 失敗時はブロック (true) を返す。
    // 本番ログには記録するが、クライアント body には reason を渡さない（情報漏洩対策）。
    console.error('[ai-usage-guard] ai_usage_exceeded RPC failed', {
      message: error.message,
    })
    return { exceeded: true, scope: 'unknown', reason: 'rpc_error' }
  }

  // 返却は jsonb (object) として届く。型は緩く扱う。
  const raw = (data ?? {}) as Record<string, unknown>
  const exceeded = raw.exceeded === true
  if (!exceeded) return { exceeded: false }

  return {
    exceeded: true,
    scope: (raw.scope as LimitScope | undefined) ?? 'unknown',
    reset_at: typeof raw.reset_at === 'string' ? raw.reset_at : undefined,
    reason: typeof raw.reason === 'string' ? raw.reason : undefined,
  }
}

/**
 * 上限到達応答の標準ボディ (429)。モーダル文言出し分けに利用。
 */
export function aiLimitExceededBody(check: CheckResult): {
  error: string
  code: 'AI_LIMIT_EXCEEDED'
  scope: LimitScope
  reset_at?: string
} {
  return {
    error: '今日の上限に達しました',
    code: 'AI_LIMIT_EXCEEDED',
    scope: check.scope ?? 'unknown',
    reset_at: check.reset_at,
  }
}

/**
 * 使用量 log の追記 (best-effort)。INSERT 失敗してもユーザー応答は成功させる。
 * cost_usd_estimate は呼び元で計算済の値を渡す (route ごとに料金体系が違うため)。
 */
export async function logAiUsage(params: {
  familyId: string
  userId: string
  endpoint:
    | 'format-item'
    | 'chat-stream'
    | 'whiteout-preview'
    | 'whiteout-apply'
  inputTokens?: number
  outputTokens?: number
  costUsdEstimate?: number
}): Promise<void> {
  try {
    const svc = createSupabaseServiceClient()
    // 型補完のため any 経由で挿入 (database.types.ts 再生成タイミングまで)。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (svc as any).from('ai_usage_log').insert({
      family_id: params.familyId,
      user_id: params.userId,
      endpoint: params.endpoint,
      input_tokens: params.inputTokens ?? 0,
      output_tokens: params.outputTokens ?? 0,
      cost_usd_estimate: params.costUsdEstimate ?? 0,
    })
    if (error) {
      console.warn('[ai-usage-guard] ai_usage_log insert failed', {
        endpoint: params.endpoint,
        message: error.message,
      })
    }
  } catch (e) {
    // 例外も飲み込む (best-effort)。ユーザー応答を阻害しない。
    console.warn('[ai-usage-guard] ai_usage_log insert exception', e)
  }
}

/**
 * family_id を auth ユーザー ID から解決する。
 * - middleware の x-family-id ヘッダは headers() からしか取れず、Edge runtime の
 *   API route handler から確実には取れないため、family_members を直接 SELECT する。
 * - service role client を使うので RLS は無関係 (内部 helper として使う)。
 */
export async function resolveFamilyIdByUser(
  userId: string,
): Promise<string | null> {
  const svc = createSupabaseServiceClient()
  const { data, error } = await svc
    .from('family_members')
    .select('family_id')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) {
    console.warn('[ai-usage-guard] resolveFamilyIdByUser failed', {
      message: error.message,
    })
    return null
  }
  return (data?.family_id as string | undefined) ?? null
}
