import { describe, it, expect } from 'vitest'
import {
  parseBuiltinBboxJson,
  isBuiltinBboxSlug,
  resolveBuiltinBboxSlugFromProcessedPath,
  loadBuiltinBboxOverrides,
} from '@/lib/builtin-bbox-loader'

/**
 * builtin bbox loader の unit test。
 *
 * テスト要件:
 *   1) bbox JSON 読込ヘルパが正しく `fields` セクションを抽出すること
 *   2) 不正 JSON / 不正形式で `null` ないし `{}` を返し throw しないこと
 *   3) processed_path → slug 逆引きが期待通り動くこと
 *   4) 許可リスト外 slug は弾くこと
 */

describe('parseBuiltinBboxJson', () => {
  it('正常な JSON から fields を w/h 形式に変換できる', () => {
    const raw = {
      slug: 'family-meeting',
      page: { width: 595, height: 842 },
      fields: {
        attendees: { x: 100, y: 200, width: 300, height: 50 },
        agenda: { x: 100, y: 260, width: 300, height: 80 },
      },
    }
    const out = parseBuiltinBboxJson(raw)
    expect(out).toEqual({
      attendees: { x: 100, y: 200, w: 300, h: 50 },
      agenda: { x: 100, y: 260, w: 300, h: 80 },
    })
  })

  it('fields キーが無い JSON は {} を返す（throw しない）', () => {
    expect(parseBuiltinBboxJson({})).toEqual({})
    expect(parseBuiltinBboxJson({ meta: {} })).toEqual({})
  })

  it('数値以外 / 負値 / NaN を含む field は捨てる', () => {
    const raw = {
      fields: {
        good: { x: 10, y: 20, width: 30, height: 40 },
        bad_neg: { x: 10, y: 20, width: -1, height: 40 },
        bad_nan: { x: Number.NaN, y: 20, width: 30, height: 40 },
        bad_zero: { x: 0, y: 0, width: 0, height: 40 },
        bad_type: { x: '10', y: 20, width: 30, height: 40 },
      },
    }
    const out = parseBuiltinBboxJson(raw)
    expect(Object.keys(out)).toEqual(['good'])
    expect(out.good).toEqual({ x: 10, y: 20, w: 30, h: 40 })
  })

  it('null / 不正型を受けても throw せず {} を返す', () => {
    expect(parseBuiltinBboxJson(null)).toEqual({})
    expect(parseBuiltinBboxJson(undefined)).toEqual({})
    expect(parseBuiltinBboxJson('abc')).toEqual({})
    expect(parseBuiltinBboxJson(123)).toEqual({})
    expect(parseBuiltinBboxJson({ fields: 'broken' })).toEqual({})
  })

  it('長すぎる field name (>100) は捨てる', () => {
    const longName = 'a'.repeat(101)
    const raw = {
      fields: {
        ok: { x: 1, y: 1, width: 1, height: 1 },
        [longName]: { x: 2, y: 2, width: 2, height: 2 },
      },
    }
    const out = parseBuiltinBboxJson(raw)
    expect(Object.keys(out)).toEqual(['ok'])
  })
})

describe('isBuiltinBboxSlug', () => {
  it('3 件の builtin slug を許可する', () => {
    expect(isBuiltinBboxSlug('family-meeting')).toBe(true)
    expect(isBuiltinBboxSlug('child-schedule')).toBe(true)
    expect(isBuiltinBboxSlug('budget-report')).toBe(true)
  })

  it('それ以外は弾く', () => {
    expect(isBuiltinBboxSlug('other')).toBe(false)
    expect(isBuiltinBboxSlug('')).toBe(false)
    expect(isBuiltinBboxSlug('family_meeting')).toBe(false)
  })
})

describe('resolveBuiltinBboxSlugFromProcessedPath', () => {
  it('seed.sql の processed_path 3 件を逆引きできる', () => {
    expect(
      resolveBuiltinBboxSlugFromProcessedPath('builtin/family_meeting_processed.docx'),
    ).toBe('family-meeting')
    expect(
      resolveBuiltinBboxSlugFromProcessedPath('builtin/child_schedule_processed.docx'),
    ).toBe('child-schedule')
    expect(
      resolveBuiltinBboxSlugFromProcessedPath('builtin/budget_report_processed.docx'),
    ).toBe('budget-report')
  })

  it('未知 / null / undefined は null を返す', () => {
    expect(resolveBuiltinBboxSlugFromProcessedPath(null)).toBe(null)
    expect(resolveBuiltinBboxSlugFromProcessedPath(undefined)).toBe(null)
    expect(resolveBuiltinBboxSlugFromProcessedPath('user/abc.pdf')).toBe(null)
    expect(resolveBuiltinBboxSlugFromProcessedPath('')).toBe(null)
  })
})

describe('loadBuiltinBboxOverrides (実ファイル)', () => {
  it('family-meeting の bbox JSON を読み込み 5 field 返す', async () => {
    const out = await loadBuiltinBboxOverrides('family-meeting')
    expect(out).not.toBeNull()
    if (!out) return
    expect(Object.keys(out).sort()).toEqual(
      ['agenda', 'attendees', 'decisions', 'discussion', 'todos'].sort(),
    )
    // 全 field が 595x842 viewport 内にあること
    for (const v of Object.values(out)) {
      expect(v.x).toBeGreaterThanOrEqual(0)
      expect(v.y).toBeGreaterThanOrEqual(0)
      expect(v.x + v.w).toBeLessThanOrEqual(595)
      expect(v.y + v.h).toBeLessThanOrEqual(842)
      expect(v.w).toBeGreaterThan(0)
      expect(v.h).toBeGreaterThan(0)
    }
  })

  it('child-schedule の bbox JSON を読み込める', async () => {
    const out = await loadBuiltinBboxOverrides('child-schedule')
    expect(out).not.toBeNull()
    if (!out) return
    expect(Object.keys(out).sort()).toEqual(
      ['discussion', 'escort', 'items', 'notes', 'place'].sort(),
    )
  })

  it('budget-report の bbox JSON を読み込める', async () => {
    const out = await loadBuiltinBboxOverrides('budget-report')
    expect(out).not.toBeNull()
    if (!out) return
    expect(Object.keys(out).sort()).toEqual(
      ['discussion', 'expense', 'income', 'month', 'next_plan', 'savings'].sort(),
    )
  })

  it('許可リスト外 slug は null', async () => {
    const out = await loadBuiltinBboxOverrides('unknown-slug')
    expect(out).toBeNull()
  })
})
