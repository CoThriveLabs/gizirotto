/**
 * POST /api/family/request-reset
 *
 * 家族からの「上限リセット依頼」を受け、reset_requests に記録 → notify-mail
 * Edge Function 経由で運営にメール送信する。
 * 1 家族 1 日 1 回。当日境界は DB 側 RPC で JST 0:00 評価 (サーバ TZ 非依存)。
 */

import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { createSupabaseServiceClient } from '@/lib/supabase/service'
import { resolveFamilyIdByUser } from '@/lib/ai-usage-guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET: usage section の「本日依頼済み」表示用。
 * 当日 (JST) に既に依頼済みかを返す。
 */
export async function GET() {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 })
  }

  const svc = createSupabaseServiceClient()
  const familyId = await resolveFamilyIdByUser(user.id)
  if (!familyId) {
    return NextResponse.json({ error: 'NOT_IN_FAMILY' }, { status: 400 })
  }

  const { data: alreadyToday } = await svc.rpc(
    'reset_request_exists_today_jst',
    { p_family_id: familyId },
  )
  return NextResponse.json({ requestedToday: alreadyToday === true })
}

export async function POST() {
  // 1) 認証 (user-session client)
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 })
  }
  const userId = user.id

  const svc = createSupabaseServiceClient()

  // 2) family_id 解決 (Phase 0 ヘルパ流用)
  const familyId = await resolveFamilyIdByUser(userId)
  if (!familyId) {
    return NextResponse.json({ error: 'NOT_IN_FAMILY' }, { status: 400 })
  }

  // 3) 1 家族 1 日 1 回チェック (JST 0:00 起点・DB 側 RPC)
  const { data: alreadyToday } = await svc.rpc(
    'reset_request_exists_today_jst',
    { p_family_id: familyId },
  )
  if (alreadyToday === true) {
    return NextResponse.json(
      {
        error: '本日は既にリセット依頼を送信済みです',
        code: 'RESET_ALREADY_REQUESTED',
      },
      { status: 429 },
    )
  }

  // 4) 記録 INSERT
  const { error: insErr } = await svc
    .from('reset_requests')
    .insert({ family_id: familyId, requested_by: userId })
  if (insErr) {
    return NextResponse.json({ error: '内部エラー' }, { status: 500 })
  }

  // 5) notify-mail Edge Function を叩く (Resend 経由)。
  //    env 未設定 (ローカル) では skip し、記録のみで 200 を返す。
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const secretKey = process.env.SUPABASE_SECRET_KEY
  if (supabaseUrl && secretKey) {
    const usage = await collectFamilyUsage(svc, familyId)
    try {
      await fetch(`${supabaseUrl}/functions/v1/notify-mail`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          kind: 'reset_request',
          family_id: familyId,
          requested_by: userId,
          usage,
        }),
      })
    } catch (e) {
      // メール失敗は記録済みの依頼を覆さない (best-effort)。
      console.warn('[request-reset] notify-mail failed', e)
    }
  }

  return NextResponse.json({ ok: true })
}

/**
 * usage section / メール本文用の軽量集計。/api/family/usage と同等の値を返す。
 */
async function collectFamilyUsage(
  svc: ReturnType<typeof createSupabaseServiceClient>,
  familyId: string,
): Promise<{ ai: number; minutes: number; templates: number }> {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const now = new Date()
  const monthStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    1,
  ).toISOString()

  const { count: aiUsed } = await svc
    .from('ai_usage_log')
    .select('id', { count: 'exact', head: true })
    .eq('family_id', familyId)
    .gt('created_at', dayAgo)

  const { count: minutesUsed } = await svc
    .from('minutes')
    .select('id', { count: 'exact', head: true })
    .eq('family_id', familyId)
    .gte('created_at', monthStart)

  const { count: templatesUsed } = await svc
    .from('templates')
    .select('id', { count: 'exact', head: true })
    .eq('family_id', familyId)

  return {
    ai: aiUsed ?? 0,
    minutes: minutesUsed ?? 0,
    templates: templatesUsed ?? 0,
  }
}
