import { describe, it, expect } from 'vitest'
import { loadBuiltinBboxOverrides } from '@/lib/builtin-bbox-loader'
import { parseFieldOverrides } from '@/lib/pdf-output/field-override'

/**
 * 議事内容（discussion）bbox が AdjustView に
 * 描画されるまでの round-trip を純関数レベルで検証する。
 *
 * 観点:
 *   1) bbox JSON ローダが 3 件すべての builtin で `discussion` を含めて返すこと
 *      （createMinute 時に bbox_overrides に焼き込まれる初期データの担保）
 *   2) parseFieldOverrides を通しても `discussion` キーが落ちないこと
 *      （AdjustView 着地時に bboxFallbackForFields に渡る値の担保）
 *   3) 各値が AdjustView 描画条件（x/y/w/h 全部 finite かつ w/h > 0）を満たすこと
 *
 *   ⚠ もし将来 parseFieldOverrides 側で snake_case 強制 / key 名検証 / 長さ制限が
 *   追加されて `discussion` がドロップした場合、本テストで即気付ける（mistake.md
 *   「ユーザー未指示の機能撤去禁止」の retrospective として有効）。
 */

describe('builtin discussion bbox round-trip', () => {
  const slugs = ['family-meeting', 'child-schedule', 'budget-report'] as const

  it.each(slugs)(
    '%s: discussion が bbox JSON → bbox_overrides → parseFieldOverrides を経ても残る',
    async (slug) => {
      // step 1: bbox JSON ローダ（createMinute が server side で叩く経路）
      const loaded = await loadBuiltinBboxOverrides(slug)
      expect(loaded, `loaded slug=${slug}`).not.toBeNull()
      expect(loaded!.discussion, `loaded.discussion slug=${slug}`).toBeDefined()
      expect(loaded!.discussion.x).toBeGreaterThan(0)
      expect(loaded!.discussion.y).toBeGreaterThan(0)
      expect(loaded!.discussion.w).toBeGreaterThan(0)
      expect(loaded!.discussion.h).toBeGreaterThan(0)

      // step 2: bbox_overrides として DB に格納された jsonb を parseFieldOverrides で復元
      // （adjust/page.tsx L50 の経路と同じ）
      const overrides = parseFieldOverrides(loaded)
      expect(overrides.discussion, `overrides.discussion slug=${slug}`).toBeDefined()
      expect(overrides.discussion!.x).toBe(loaded!.discussion.x)
      expect(overrides.discussion!.y).toBe(loaded!.discussion.y)
      expect(overrides.discussion!.w).toBe(loaded!.discussion.w)
      expect(overrides.discussion!.h).toBe(loaded!.discussion.h)

      // step 3: bboxFallbackForFields 構築（adjust/page.tsx L56-67 の経路と同じ）
      const fallback: Record<
        string,
        { x: number; y: number; w: number; h: number }
      > = {}
      for (const [name, ov] of Object.entries(overrides)) {
        if (
          ov &&
          typeof ov.x === 'number' &&
          typeof ov.y === 'number' &&
          typeof ov.w === 'number' &&
          typeof ov.h === 'number'
        ) {
          fallback[name] = { x: ov.x, y: ov.y, w: ov.w, h: ov.h }
        }
      }
      expect(fallback.discussion, `fallback.discussion slug=${slug}`).toBeDefined()
    },
  )
})
