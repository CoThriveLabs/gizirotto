/**
 * countUnreflectedMinutes（未反映バッジ判定の純粋ロジック）テスト。
 * source_minutes_ids との差分件数計算・閾値判定・異常系を検証する。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  countUnreflectedMinutes,
  STYLE_UNREFLECTED_BADGE_THRESHOLD,
} from '@/lib/ai/style/count-unreflected-minutes'

function makeDb(rows: Array<{ id: string }>, error: unknown = null) {
  return {
    from: (table: string) => {
      if (table !== 'minutes') throw new Error(`unexpected table: ${table}`)
      return {
        select: () => ({
          eq: () => ({
            eq: async () => ({ data: error ? null : rows, error }),
          }),
        }),
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('countUnreflectedMinutes', () => {
  it('プロファイル未生成（source_minutes_ids空）なら全件が未反映扱いになる', async () => {
    const db = makeDb([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    const result = await countUnreflectedMinutes(db, 'family-1', [])
    expect(result.unreflectedCount).toBe(3)
  })

  it('source_minutes_ids に含まれる議事録は未反映カウントから除外される', async () => {
    const db = makeDb([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    const result = await countUnreflectedMinutes(db, 'family-1', ['a', 'b'])
    expect(result.unreflectedCount).toBe(1)
    expect(result.shouldShowBadge).toBe(false)
  })

  it('未反映件数が既定閾値(5件)以上なら shouldShowBadge:true', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: `m${i}` }))
    const db = makeDb(rows)
    const result = await countUnreflectedMinutes(db, 'family-1', [])
    expect(result.unreflectedCount).toBe(5)
    expect(result.shouldShowBadge).toBe(true)
    expect(STYLE_UNREFLECTED_BADGE_THRESHOLD).toBe(5)
  })

  it('未反映件数が閾値未満(4件)なら shouldShowBadge:false', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({ id: `m${i}` }))
    const db = makeDb(rows)
    const result = await countUnreflectedMinutes(db, 'family-1', [])
    expect(result.unreflectedCount).toBe(4)
    expect(result.shouldShowBadge).toBe(false)
  })

  it('全件が学習済み(差分0件)なら shouldShowBadge:false', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ id: `m${i}` }))
    const db = makeDb(rows)
    const result = await countUnreflectedMinutes(
      db,
      'family-1',
      rows.map((r) => r.id),
    )
    expect(result.unreflectedCount).toBe(0)
    expect(result.shouldShowBadge).toBe(false)
  })

  it('カスタム閾値を指定できる', async () => {
    const rows = Array.from({ length: 2 }, (_, i) => ({ id: `m${i}` }))
    const db = makeDb(rows)
    const result = await countUnreflectedMinutes(db, 'family-1', [], 2)
    expect(result.shouldShowBadge).toBe(true)
  })

  it('DBエラー時は安全側（0件・false）に倒す', async () => {
    const db = makeDb([], { message: 'db error' })
    const result = await countUnreflectedMinutes(db, 'family-1', [])
    expect(result).toEqual({ unreflectedCount: 0, shouldShowBadge: false })
  })
})
