import type { SupabaseClient } from '@supabase/supabase-js'
import { checkAiUsage } from '@/lib/ai-usage-guard'
import { buildStyleProfile, STYLE_MIN_MINUTES } from './build-style-profile'
import { isStyleLearningEnabled } from './is-style-learning-enabled'
import { asStyleDb } from './style-db-types'
import { logStyleProfileUsage } from './log-style-profile-usage'

/**
 * 議事録作成完了後に呼ぶ、初回スタイルプロファイル生成トリガ。
 *
 * 学習対象議事録（exclude_from_learning=false）が閾値にちょうど到達したタイミングでのみ
 * best-effort でプロファイル生成する。「閾値以上なら毎回」ではなく「ちょうど到達時のみ」に
 * 絞ることで、閾値超過後に議事録を作るたびに再生成が走るコスト増を避ける
 * （自動の毎回再生成はしない方針）。
 *
 * regenerateStyleProfile（手動再生成）と同様、AI 呼出前に checkAiUsage で quota を確認し、
 * 呼出後は logStyleProfileUsage でコストを記録する。quota 超過時は例外を投げず、
 * この経路の AI 呼出だけを静かにスキップする（best-effort 方針を維持）。
 *
 * DB エラー・AI 呼出失敗はすべて飲み込み、呼出元（createMinute）の CRUD 成否に影響させない。
 */
export async function maybeTriggerStyleProfile(args: {
  db: SupabaseClient
  familyId: string
  userId: string
  anthropicApiKey: string | undefined
  anthropicModel: string | undefined
  minMinutes?: number
}): Promise<void> {
  try {
    const minMinutes = args.minMinutes ?? STYLE_MIN_MINUTES
    if (!args.anthropicApiKey || !args.anthropicModel) return

    const enabled = await isStyleLearningEnabled(asStyleDb(args.db), args.familyId)
    if (!enabled) return

    const { count, error } = await args.db
      .from('minutes')
      .select('id', { count: 'exact', head: true })
      .eq('family_id', args.familyId)
      .eq('exclude_from_learning', false)
    if (error || typeof count !== 'number') return

    // ちょうど閾値到達時のみ発火（超過分は手動再生成 or バッジ経由に委ねる）。
    if (count !== minMinutes) return

    const usageCheck = await checkAiUsage({ familyId: args.familyId, userId: args.userId })
    if (usageCheck.exceeded) {
      console.warn('[maybeTriggerStyleProfile] quota exceeded, skipped', {
        familyId: args.familyId,
        reason: usageCheck.reason,
      })
      return
    }

    const result = await buildStyleProfile({
      // build-style-profile.ts が使うのは from().select().eq().eq().order().limit() /
      // from().upsert() のみの最小インタフェースなので、実クライアントは構造的に適合する。
      db: args.db as unknown as Parameters<typeof buildStyleProfile>[0]['db'],
      familyId: args.familyId,
      anthropicApiKey: args.anthropicApiKey,
      anthropicModel: args.anthropicModel,
      minMinutes,
    })

    void logStyleProfileUsage(result, { familyId: args.familyId, userId: args.userId })
  } catch (e) {
    console.warn('[maybeTriggerStyleProfile] skipped due to error', {
      familyId: args.familyId,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}
