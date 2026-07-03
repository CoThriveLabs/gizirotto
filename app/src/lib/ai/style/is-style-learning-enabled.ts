/**
 * 世帯単位の学習 ON/OFF 判定（families.style_learning_enabled）。
 * 取得失敗時は安全側（学習しない=false）に倒す。
 */
import type { StyleDb } from './style-db-types'

export async function isStyleLearningEnabled(db: StyleDb, familyId: string): Promise<boolean> {
  try {
    const { data, error } = await db
      .from('families')
      .select('style_learning_enabled')
      .eq('id', familyId)
      .maybeSingle()
    if (error || !data) return false
    return data.style_learning_enabled !== false
  } catch {
    return false
  }
}
