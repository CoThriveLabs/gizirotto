'use server'

import { createSupabaseServerClient } from '@/lib/supabase/server'
import { decodeAccessTokenClaims } from '@/lib/jwt-claims'
import { checkAiUsage, aiLimitExceededBody } from '@/lib/ai-usage-guard'
import {
  buildStyleProfile,
  type BuildStyleProfileResult,
} from '@/lib/ai/style/build-style-profile'
import { logStyleProfileUsage } from '@/lib/ai/style/log-style-profile-usage'
import {
  countUnreflectedMinutes,
  STYLE_UNREFLECTED_BADGE_THRESHOLD,
} from '@/lib/ai/style/count-unreflected-minutes'

/**
 * 家庭スタイルプロファイル生成 Server Action。
 *
 * 設定画面の「書き方を学習し直す」ボタン、および将来の自動トリガ（3件到達時）から
 * 呼ばれる共通口。family_id は JWT claims から解決し、AI 呼出は quota 消費対象にする。
 */
export async function regenerateStyleProfile(): Promise<
  BuildStyleProfileResult | { ok: false; skippedReason: 'AI_LIMIT_EXCEEDED' }
> {
  const supabase = await createSupabaseServerClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('UNAUTHENTICATED')

  const { data: sessionData } = await supabase.auth.getSession()
  const familyId = decodeAccessTokenClaims(sessionData.session?.access_token)?.family_id
  if (!familyId) throw new Error('NOT_IN_FAMILY')

  const usageCheck = await checkAiUsage({ familyId, userId: user.id })
  if (usageCheck.exceeded) {
    // aiLimitExceededBody は route の 429 body 生成用だが、reason だけ流用してログにも残す。
    console.warn('[style-profile] quota exceeded', aiLimitExceededBody(usageCheck))
    return { ok: false, skippedReason: 'AI_LIMIT_EXCEEDED' }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  const model = process.env.ANTHROPIC_MODEL
  if (!apiKey || !model) throw new Error('AI_NOT_CONFIGURED')

  const result = await buildStyleProfile({
    // build-style-profile.ts は from().select().eq().eq().order().limit() /
    // from().upsert() のみを使う最小インタフェースなので、実クライアントは構造的に適合する。
    db: supabase as unknown as Parameters<typeof buildStyleProfile>[0]['db'],
    familyId,
    anthropicApiKey: apiKey,
    anthropicModel: model,
  })

  // best-effort ログ（プロファイル生成自体の成否に関わらず、AI 呼出コストは記録する）。
  void logStyleProfileUsage(result, { familyId, userId: user.id })

  return result
}

export type StyleLearningStateResult = {
  ok: true
  enabled: boolean
  hasProfile: boolean
  lastUpdatedAt: string | null
} | { ok: false; code: 'UNAUTHENTICATED' | 'NOT_IN_FAMILY' }

/**
 * 設定画面表示用の現在状態取得（学習 ON/OFF・プロファイル生成済か・最終更新日時）。
 */
export async function getStyleLearningState(): Promise<StyleLearningStateResult> {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, code: 'UNAUTHENTICATED' }

  const { data: sessionData } = await supabase.auth.getSession()
  const familyId = decodeAccessTokenClaims(sessionData.session?.access_token)?.family_id
  if (!familyId) return { ok: false, code: 'NOT_IN_FAMILY' }

  const { data: family } = await supabase
    .from('families')
    .select('style_learning_enabled')
    .eq('id', familyId)
    .maybeSingle()

  const { data: styleRow } = await supabase
    .from('user_styles')
    .select('last_updated_at')
    .eq('family_id', familyId)
    .maybeSingle()

  return {
    ok: true,
    enabled: family?.style_learning_enabled !== false,
    hasProfile: !!styleRow,
    lastUpdatedAt: styleRow?.last_updated_at ?? null,
  }
}

/**
 * 世帯単位の学習 ON/OFF トグル。OFF にしてもプロファイル自体は削除しない
 * （再度 ON にすれば復活する。完全削除は deleteStyleLearningData で行う）。
 */
export async function setStyleLearningEnabled(
  enabled: boolean,
): Promise<{ ok: true } | { ok: false; code: 'UNAUTHENTICATED' | 'NOT_IN_FAMILY' | 'DB_ERROR' }> {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, code: 'UNAUTHENTICATED' }

  const { data: sessionData } = await supabase.auth.getSession()
  const familyId = decodeAccessTokenClaims(sessionData.session?.access_token)?.family_id
  if (!familyId) return { ok: false, code: 'NOT_IN_FAMILY' }

  const { error } = await supabase
    .from('families')
    .update({ style_learning_enabled: enabled })
    .eq('id', familyId)
  if (error) return { ok: false, code: 'DB_ERROR' }

  return { ok: true }
}

export type UnreflectedMinutesBadgeResult =
  | { ok: true; unreflectedCount: number; shouldShowBadge: boolean }
  | { ok: false; code: 'UNAUTHENTICATED' | 'NOT_IN_FAMILY' }

/**
 * 「新しい議事録から学び直せます」バッジ判定。
 * user_styles.source_minutes_ids に含まれない学習対象議事録が閾値件数以上なら
 * shouldShowBadge:true を返す。自動再生成はせず、UI 側の手動再生成導線に委ねる。
 */
export async function getUnreflectedMinutesBadge(): Promise<UnreflectedMinutesBadgeResult> {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, code: 'UNAUTHENTICATED' }

  const { data: sessionData } = await supabase.auth.getSession()
  const familyId = decodeAccessTokenClaims(sessionData.session?.access_token)?.family_id
  if (!familyId) return { ok: false, code: 'NOT_IN_FAMILY' }

  const { data: styleRow } = await supabase
    .from('user_styles')
    .select('source_minutes_ids')
    .eq('family_id', familyId)
    .maybeSingle()

  const { unreflectedCount, shouldShowBadge } = await countUnreflectedMinutes(
    // count-unreflected-minutes.ts は from().select().eq().eq() のみを使う最小インタフェース
    // なので、実クライアントは構造的に適合する。
    supabase as unknown as Parameters<typeof countUnreflectedMinutes>[0],
    familyId,
    (styleRow?.source_minutes_ids as string[] | null) ?? [],
    STYLE_UNREFLECTED_BADGE_THRESHOLD,
  )

  return { ok: true, unreflectedCount, shouldShowBadge }
}

/**
 * 学習データ（user_styles プロファイル）の完全削除。PRIVACY.md L64「学習された書式の削除」を担保する。
 */
export async function deleteStyleLearningData(): Promise<
  { ok: true } | { ok: false; code: 'UNAUTHENTICATED' | 'NOT_IN_FAMILY' | 'DB_ERROR' }
> {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, code: 'UNAUTHENTICATED' }

  const { data: sessionData } = await supabase.auth.getSession()
  const familyId = decodeAccessTokenClaims(sessionData.session?.access_token)?.family_id
  if (!familyId) return { ok: false, code: 'NOT_IN_FAMILY' }

  const { error } = await supabase.from('user_styles').delete().eq('family_id', familyId)
  if (error) return { ok: false, code: 'DB_ERROR' }

  return { ok: true }
}
