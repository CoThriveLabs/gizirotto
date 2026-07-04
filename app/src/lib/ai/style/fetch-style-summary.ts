/**
 * チャット(A-1/A-2)・整形(B-2) の両経路から共通で呼ぶ、注入用スタイル要約の取得ヘルパー。
 *
 * 学習 OFF（families.style_learning_enabled=false）または未生成・取得失敗は
 * すべて null を返す。呼出側は null を「従来どおり注入しない」として扱う。
 */
import type { StyleDb } from './style-db-types'
import { isStyleLearningEnabled } from './is-style-learning-enabled'

function extractSummaryText(profile: unknown): string | null {
  if (!profile || typeof profile !== 'object') return null
  const summary = (profile as Record<string, unknown>).summary_text
  return typeof summary === 'string' && summary.length > 0 ? summary : null
}

export async function fetchStyleSummary(db: StyleDb, familyId: string): Promise<string | null> {
  try {
    const enabled = await isStyleLearningEnabled(db, familyId)
    if (!enabled) return null

    const { data: styleRow, error: styleError } = await db
      .from('user_styles')
      .select('profile')
      .eq('family_id', familyId)
      .maybeSingle()
    if (styleError || !styleRow) return null

    return extractSummaryText(styleRow.profile)
  } catch {
    return null
  }
}
