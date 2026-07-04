/**
 * 整形(B-2) omakase トーン専用の few-shot 補助注入。
 *
 * embedding は使わず、family の過去 minutes から同じ field_name の値を
 * meeting_date desc で直近 N 件取得するだけの単純クエリ（設計書 §5-2 案B）。
 */
import type { StyleDb } from './style-db-types'

const PAST_EXAMPLE_LIMIT = 2
const PAST_EXAMPLE_TRUNCATE = 300
const PAST_EXAMPLE_SCAN_LIMIT = 20

function extractFieldValue(contentJson: unknown, fieldName: string): string | null {
  if (!contentJson || typeof contentJson !== 'object') return null
  const value = (contentJson as Record<string, unknown>)[fieldName]
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((v) => String(v)).join('\n')
  return null
}

/**
 * family の過去 minutes（exclude_from_learning=false）から、同じ field_name の
 * 値を直近 2 件・各 300 字 truncate で取得する。取得失敗・0 件は空配列を返す（落とさない）。
 */
export async function fetchPastFieldExamples(
  db: StyleDb,
  args: { familyId: string; fieldName: string },
): Promise<string[]> {
  try {
    const { data, error } = await db
      .from('minutes')
      .select('content_json')
      .eq('family_id', args.familyId)
      .eq('exclude_from_learning', false)
      .order('meeting_date', { ascending: false })
      .limit(PAST_EXAMPLE_SCAN_LIMIT)
    if (error || !data) return []

    const examples: string[] = []
    for (const row of data) {
      const value = extractFieldValue(row.content_json, args.fieldName)
      if (!value) continue
      examples.push(value.slice(0, PAST_EXAMPLE_TRUNCATE))
      if (examples.length >= PAST_EXAMPLE_LIMIT) break
    }
    return examples
  } catch {
    return []
  }
}
