'use server'

import { createSupabaseServerClient } from '@/lib/supabase/server'
import { decodeAccessTokenClaims } from '@/lib/jwt-claims'
import { checkAiUsage, aiLimitExceededBody, logAiUsage } from '@/lib/ai-usage-guard'
import {
  buildStyleProfile,
  type BuildStyleProfileResult,
} from '@/lib/ai/style/build-style-profile'

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
  // skip 系（NO_MINUTES/EMPTY_CONTENT）は Anthropic 未呼出のためコスト 0 で記録。
  const calledAi =
    result.skippedReason !== 'NO_MINUTES' && result.skippedReason !== 'EMPTY_CONTENT'
  if (calledAi) {
    const inputTokens = result.usage?.inputTokens ?? 0
    const outputTokens = result.usage?.outputTokens ?? 0
    // Claude Haiku 3.5 estimate: input $3 / output $15 per 1M tokens.
    const cost = (inputTokens * 3 + outputTokens * 15) / 1_000_000
    void logAiUsage({
      familyId,
      userId: user.id,
      endpoint: 'style-profile',
      inputTokens,
      outputTokens,
      costUsdEstimate: cost,
    })
  }

  return result
}
