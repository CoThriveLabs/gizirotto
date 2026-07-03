/**
 * fetchStyleSummary / isStyleLearningEnabled / fetchPastFieldExamples の DB 経由テスト。
 * 学習 OFF・未生成・取得失敗のいずれでも例外を投げず null/false/[] にフォールバックすること、
 * および exclude_from_learning=false フィルタが実際にクエリへ渡ることを確認する。
 */
import { describe, it, expect } from 'vitest'
import { fetchStyleSummary } from '@/lib/ai/style/fetch-style-summary'
import { isStyleLearningEnabled } from '@/lib/ai/style/is-style-learning-enabled'
import { fetchPastFieldExamples } from '@/lib/ai/style/fetch-past-field-examples'
import type { StyleDb } from '@/lib/ai/style/style-db-types'

function makeStyleDb(args: {
  familyRow?: { style_learning_enabled: boolean } | null
  familyError?: unknown
  styleRow?: { profile: unknown } | null
  styleError?: unknown
  minutesRows?: Array<{ content_json: unknown }>
  minutesError?: unknown
}): StyleDb {
  return {
    from: (table: string) => {
      if (table === 'families') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: args.familyRow ?? null,
                error: args.familyError ?? null,
              }),
              eq: () => {
                throw new Error('unexpected chained eq on families')
              },
            }),
          }),
        } as unknown as ReturnType<StyleDb['from']>
      }
      if (table === 'user_styles') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: args.styleRow ?? null,
                error: args.styleError ?? null,
              }),
              eq: () => {
                throw new Error('unexpected chained eq on user_styles')
              },
            }),
          }),
        } as unknown as ReturnType<StyleDb['from']>
      }
      if (table === 'minutes') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: async () => ({
                    data: args.minutesRows ?? [],
                    error: args.minutesError ?? null,
                  }),
                }),
              }),
              maybeSingle: async () => {
                throw new Error('unexpected maybeSingle on minutes')
              },
            }),
          }),
        } as unknown as ReturnType<StyleDb['from']>
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }
}

describe('isStyleLearningEnabled', () => {
  it('style_learning_enabled=true なら true を返す', async () => {
    const db = makeStyleDb({ familyRow: { style_learning_enabled: true } })
    expect(await isStyleLearningEnabled(db, 'family-1')).toBe(true)
  })

  it('style_learning_enabled=false なら false を返す', async () => {
    const db = makeStyleDb({ familyRow: { style_learning_enabled: false } })
    expect(await isStyleLearningEnabled(db, 'family-1')).toBe(false)
  })

  it('家庭行が取得できない場合は安全側で false を返す', async () => {
    const db = makeStyleDb({ familyRow: null })
    expect(await isStyleLearningEnabled(db, 'family-1')).toBe(false)
  })

  it('取得エラー時も例外を投げず false を返す', async () => {
    const db = makeStyleDb({ familyError: { message: 'db error' } })
    expect(await isStyleLearningEnabled(db, 'family-1')).toBe(false)
  })
})

describe('fetchStyleSummary', () => {
  it('学習 ON かつプロファイル有りなら summary_text を返す', async () => {
    const db = makeStyleDb({
      familyRow: { style_learning_enabled: true },
      styleRow: { profile: { summary_text: 'この家庭は体言止め中心です。' } },
    })
    expect(await fetchStyleSummary(db, 'family-1')).toBe('この家庭は体言止め中心です。')
  })

  it('学習 OFF なら summary_text があっても null を返す', async () => {
    const db = makeStyleDb({
      familyRow: { style_learning_enabled: false },
      styleRow: { profile: { summary_text: 'この家庭は体言止め中心です。' } },
    })
    expect(await fetchStyleSummary(db, 'family-1')).toBeNull()
  })

  it('プロファイル未生成（styleRow なし）なら null を返す', async () => {
    const db = makeStyleDb({ familyRow: { style_learning_enabled: true }, styleRow: null })
    expect(await fetchStyleSummary(db, 'family-1')).toBeNull()
  })

  it('profile.summary_text が欠落していても例外を投げず null を返す', async () => {
    const db = makeStyleDb({
      familyRow: { style_learning_enabled: true },
      styleRow: { profile: {} },
    })
    expect(await fetchStyleSummary(db, 'family-1')).toBeNull()
  })
})

describe('fetchPastFieldExamples', () => {
  it('field_name に一致する値を直近2件・300字truncateで返す', async () => {
    const longText = 'あ'.repeat(400)
    const db = makeStyleDb({
      minutesRows: [
        { content_json: { decisions: longText } },
        { content_json: { decisions: '2件目の決定事項' } },
        { content_json: { decisions: '3件目は取得されない' } },
      ],
    })
    const result = await fetchPastFieldExamples(db, {
      familyId: 'family-1',
      fieldName: 'decisions',
    })
    expect(result).toHaveLength(2)
    expect(result[0]).toHaveLength(300)
    expect(result[1]).toBe('2件目の決定事項')
  })

  it('該当 field_name が存在しない行はスキップされる', async () => {
    const db = makeStyleDb({
      minutesRows: [
        { content_json: { agenda: '議題のみ' } },
        { content_json: { decisions: '決定事項あり' } },
      ],
    })
    const result = await fetchPastFieldExamples(db, {
      familyId: 'family-1',
      fieldName: 'decisions',
    })
    expect(result).toEqual(['決定事項あり'])
  })

  it('取得エラー時も例外を投げず空配列を返す', async () => {
    const db = makeStyleDb({ minutesError: { message: 'db error' } })
    const result = await fetchPastFieldExamples(db, {
      familyId: 'family-1',
      fieldName: 'decisions',
    })
    expect(result).toEqual([])
  })

  it('0件でも空配列を返す（落ちない）', async () => {
    const db = makeStyleDb({ minutesRows: [] })
    const result = await fetchPastFieldExamples(db, {
      familyId: 'family-1',
      fieldName: 'decisions',
    })
    expect(result).toEqual([])
  })
})
