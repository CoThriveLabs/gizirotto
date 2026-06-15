/**
 * AdjustView 中央寄せ振る舞い unit test
 * （段階2-D2 差し戻し対応・設計書 v2.1 §2-12・実機検証 復活機能の回帰防止）。
 *
 * v2.1 §2-12 復活機能（v1.0 §6-2 「中央寄せ → 削除」のこちら判断撤去を撤回）。
 *
 * 中央寄せロジックは AdjustView 内のクロージャに閉じているが、**bbox-coords の純関数
 * centerHorizontally** を呼ぶ薄いラッパなので、ここでは純関数側を直接検証する。
 *
 * 検証観点（§2-12）:
 *   - centerHorizontally で x = (pageW - w) / 2 になる
 *   - y / w / h は触らない（水平センタリングのみ）
 *   - bbox.w > pageW のときは Math.max(0, ...) で x=0（負にならない）
 *   - templates `applyCenter` と同等の挙動を bbox_overrides 経由で再現
 */
import { describe, it, expect } from 'vitest'
import { centerHorizontally } from '@/lib/pdf-output/bbox-coords'
import type { BboxOverrides } from '@/lib/pdf-output/field-override'

describe('centerHorizontally（v2.1 §2-12 復活機能の核）', () => {
  it('x = (pageW - w) / 2 で水平センタリングされる', () => {
    const result = centerHorizontally({ x: 0, y: 100, w: 200, h: 50 }, 595)
    expect(result.x).toBeCloseTo((595 - 200) / 2, 5)
    expect(result.y).toBe(100)
    expect(result.w).toBe(200)
    expect(result.h).toBe(50)
  })

  it('y / w / h は触らない（垂直方向と寸法は不変）', () => {
    const result = centerHorizontally({ x: 50, y: 300, w: 100, h: 24 }, 595)
    expect(result.y).toBe(300)
    expect(result.w).toBe(100)
    expect(result.h).toBe(24)
  })

  it('bbox.w > pageW のとき x=0（負にならない・Math.max(0, ...) ガード）', () => {
    const result = centerHorizontally({ x: 0, y: 0, w: 700, h: 24 }, 595)
    expect(result.x).toBe(0)
  })

  it('w=0 のときも x = pageW/2 でセンタリング（ガード必要なし）', () => {
    const result = centerHorizontally({ x: 0, y: 0, w: 0, h: 24 }, 595)
    expect(result.x).toBeCloseTo(595 / 2, 5)
  })
})

/**
 * AdjustView の applyCenterHorizontal と同型ロジック（純関数版）。
 * 実装本体は AdjustView 内クロージャだが、bbox_overrides 経由で x を書き換える
 * 構造が templates `applyCenter` と一貫していることを担保する。
 */
function applyCenterToOverrides(
  overrides: BboxOverrides,
  fieldName: string,
  templateBbox: { x: number; y: number; w: number; h: number },
  pageWidthPt: number,
): BboxOverrides {
  const cur = overrides[fieldName] ?? {}
  const w = cur.w ?? templateBbox.w
  const y = cur.y ?? templateBbox.y
  const h = cur.h ?? templateBbox.h
  const centered = centerHorizontally({ x: 0, y, w, h }, pageWidthPt)
  return {
    ...overrides,
    [fieldName]: { ...cur, x: centered.x },
  }
}

describe('applyCenterToOverrides（AdjustView の中央寄せロジック・bbox_overrides 経由）', () => {
  it('既存 override がない field でも templateBbox から計算', () => {
    const overrides: BboxOverrides = {}
    const result = applyCenterToOverrides(
      overrides,
      'a',
      { x: 50, y: 100, w: 200, h: 24 },
      595,
    )
    expect(result.a.x).toBeCloseTo((595 - 200) / 2, 5)
  })

  it('既存 override の w を尊重して中央寄せ（テンプレ既定の w は使わない）', () => {
    const overrides: BboxOverrides = { a: { w: 300, fontSize: 12 } }
    const result = applyCenterToOverrides(
      overrides,
      'a',
      { x: 50, y: 100, w: 200, h: 24 }, // テンプレ既定 w=200
      595,
    )
    // override の w=300 を使って中央寄せ
    expect(result.a.x).toBeCloseTo((595 - 300) / 2, 5)
    // fontSize は据置
    expect(result.a.fontSize).toBe(12)
    // w も据置
    expect(result.a.w).toBe(300)
  })

  it('他 field の override は触らない', () => {
    const overrides: BboxOverrides = {
      a: { x: 0, y: 100 },
      b: { x: 999, fontSize: 14 },
    }
    const result = applyCenterToOverrides(
      overrides,
      'a',
      { x: 0, y: 100, w: 200, h: 24 },
      595,
    )
    expect(result.b).toEqual({ x: 999, fontSize: 14 })
  })

  it('既存 y は据置（垂直方向は変えない）', () => {
    const overrides: BboxOverrides = { a: { y: 500 } }
    const result = applyCenterToOverrides(
      overrides,
      'a',
      { x: 0, y: 100, w: 200, h: 24 },
      595,
    )
    expect(result.a.y).toBe(500) // override 値を尊重
  })
})
