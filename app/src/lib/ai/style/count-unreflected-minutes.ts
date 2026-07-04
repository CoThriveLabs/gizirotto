/**
 * 「学習し直しバッジ」判定の純粋ロジック。
 *
 * user_styles.source_minutes_ids に含まれない学習対象議事録（exclude_from_learning=false）の
 * 件数を数え、既定閾値（STYLE_UNREFLECTED_BADGE_THRESHOLD）以上なら再学習を促す。
 * プロファイル未生成（source_minutes_ids が空/該当行なし）の場合は全件が未反映扱いになる。
 */

export const STYLE_UNREFLECTED_BADGE_THRESHOLD = 5

export interface UnreflectedMinutesBadgeDb {
  from(table: string): {
    select: (columns: string) => {
      eq: (
        col: string,
        val: string | boolean,
      ) => {
        eq: (
          col: string,
          val: string | boolean,
        ) => Promise<{ data: Array<{ id: string }> | null; error: unknown }>
      }
    }
  }
}

export interface UnreflectedMinutesBadgeResult {
  unreflectedCount: number
  shouldShowBadge: boolean
}

/**
 * source_minutes_ids（学習済み議事録 id 集合）と、現在の学習対象議事録 id 集合の差分を数える。
 * DB エラー時は「バッジを出さない」安全側（0件・false）に倒す。
 */
export async function countUnreflectedMinutes(
  db: UnreflectedMinutesBadgeDb,
  familyId: string,
  sourceMinutesIds: string[],
  threshold: number = STYLE_UNREFLECTED_BADGE_THRESHOLD,
): Promise<UnreflectedMinutesBadgeResult> {
  const { data, error } = await db
    .from('minutes')
    .select('id')
    .eq('family_id', familyId)
    .eq('exclude_from_learning', false)

  if (error || !data) {
    return { unreflectedCount: 0, shouldShowBadge: false }
  }

  const learnedIds = new Set(sourceMinutesIds)
  const unreflectedCount = data.filter((row) => !learnedIds.has(row.id)).length

  return {
    unreflectedCount,
    shouldShowBadge: unreflectedCount >= threshold,
  }
}
