/**
 * GET /api/family/usage — 残数バッジ用の使用量集計 API。
 *
 * 認証済みユーザーの所属家族について、AI / 議事録 / テンプレ / Storage の
 * 使用量と上限を返す。1 分粒度で polling される想定なのでクエリは軽量に保つ。
 *
 * Response:
 *   {
 *     ai: { used, cap },        // 当日の AI 呼出回数 (家族集計) / family_limits.ai_calls_per_day
 *     minutes: { used, cap },   // 当月の議事録件数 / family_limits.max_minutes_monthly
 *     templates: { used, cap }, // テンプレ累積件数 / family_limits.max_templates
 *   }
 *
 * 既存 response shape との衝突を避けるため、新規 endpoint として追加。
 */

import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { resolveFamilyIdByUser } from '@/lib/ai-usage-guard'
import { createSupabaseServiceClient } from '@/lib/supabase/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 })
  }

  const familyId = await resolveFamilyIdByUser(user.id)
  if (!familyId) {
    return NextResponse.json({ error: 'NOT_IN_FAMILY' }, { status: 404 })
  }

  // service role: limits / 集計を一気に取りに行く。RLS bypass なので軽量。
  const svc = createSupabaseServiceClient()

  // family_limits (default 行が migration で投入済の想定)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: limits } = await (svc as any)
    .from('family_limits')
    .select('ai_calls_per_day, max_minutes_monthly, max_templates')
    .eq('family_id', familyId)
    .maybeSingle()

  const aiCap = (limits?.ai_calls_per_day as number | undefined) ?? 30
  const minutesCap = (limits?.max_minutes_monthly as number | undefined) ?? 100
  const templatesCap = (limits?.max_templates as number | undefined) ?? 50

  // 当日 AI 呼出回数 (家族集計)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { count: aiUsed } = await (svc as any)
    .from('ai_usage_log')
    .select('id', { count: 'exact', head: true })
    .eq('family_id', familyId)
    .gt(
      'created_at',
      new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    )

  // 当月の議事録件数 (date_trunc('month') 相当を JS で再現)
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { count: minutesUsed } = await (svc as any)
    .from('minutes')
    .select('id', { count: 'exact', head: true })
    .eq('family_id', familyId)
    .gte('created_at', monthStart)

  // テンプレ累積件数
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { count: templatesUsed } = await (svc as any)
    .from('templates')
    .select('id', { count: 'exact', head: true })
    .eq('family_id', familyId)

  return NextResponse.json(
    {
      ai: { used: aiUsed ?? 0, cap: aiCap },
      minutes: { used: minutesUsed ?? 0, cap: minutesCap },
      templates: { used: templatesUsed ?? 0, cap: templatesCap },
    },
    {
      headers: {
        // 1 分粒度の polling 想定 → ブラウザキャッシュは無効化、毎回最新を返す。
        'cache-control': 'no-store',
      },
    },
  )
}
