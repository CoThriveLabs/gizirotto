/**
 * field-override 純関数 unit test（段階 2 D-core・
 * 設計書 minutes_adjust_editor_renewal_design_2026-06-08 §3 / §8-1）。
 *
 * 検証観点（§8-1 データ/後方互換）:
 *   - 旧 `{x,y}` のみ override → そのまま採用、w/h/fontSize は undefined（テンプレ既定保持）
 *   - `{x,y,w,h,fontSize}` フル override → bbox 差替 + font.size 差替
 *   - override 当該 field 無し → テンプレ既定そのまま
 *   - parseFieldOverrides 緩和: 不正値（数値でない w 等）を握り潰して欠損扱い
 *   - 全欄欠損の空 override は除外（ノイズ削減）
 *   - applyFieldOverride: undefined override は参照同一
 */
import { describe, it, expect } from 'vitest'
import {
  parseFieldOverrides,
  applyFieldOverride,
  applyBboxOverrides,
} from '@/lib/pdf-output/field-override'
import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'

function makeField(overrides: Partial<PdfField> = {}): PdfField {
  return {
    name: 'sample',
    label: 'サンプル',
    type: 'text',
    bbox: { page: 1, x: 100, y: 200, w: 300, h: 24 },
    max_chars: 200,
    font: { family: 'NotoSansJP', size: 11 },
    padding: { left: 4, top: 4, right: 4, bottom: 4 },
    multiline: false,
    align: 'left',
    vertical: 'top',
    writing_mode: 'horizontal',
    overflow_strategy: 'shrink_then_wrap',
    font_size_min: 8,
    ...overrides,
  }
}

describe('parseFieldOverrides', () => {
  it('旧 {x,y} のみ override を partial として受け入れる（後方互換 §3-3）', () => {
    const raw = { foo: { x: 10, y: 20 } }
    const result = parseFieldOverrides(raw)
    expect(result).toEqual({ foo: { x: 10, y: 20 } })
    expect(result.foo.w).toBeUndefined()
    expect(result.foo.h).toBeUndefined()
    expect(result.foo.fontSize).toBeUndefined()
  })

  it('フル override {x,y,w,h,fontSize} を正規化', () => {
    const raw = {
      bar: { x: 1, y: 2, w: 100, h: 30, fontSize: 14 },
    }
    expect(parseFieldOverrides(raw)).toEqual({
      bar: { x: 1, y: 2, w: 100, h: 30, fontSize: 14 },
    })
  })

  it('fontSize のみ override（位置はテンプレ既定）も partial として有効', () => {
    expect(parseFieldOverrides({ a: { fontSize: 12 } })).toEqual({
      a: { fontSize: 12 },
    })
  })

  it('不正値（文字列・NaN・0・負）は欠損扱いで握り潰す（§8-1）', () => {
    const raw = {
      bad: {
        x: 'oops',
        y: Number.NaN,
        w: 0,
        h: -5,
        fontSize: Number.POSITIVE_INFINITY,
      },
    }
    // 全フィールド欠損 = 空 override として除外（ノイズ削減）。
    expect(parseFieldOverrides(raw)).toEqual({})
  })

  it('一部不正値は当該キーだけ欠損扱い・他は採用', () => {
    expect(parseFieldOverrides({ mix: { x: 1, w: 'no' } })).toEqual({
      mix: { x: 1 },
    })
  })

  it('null / 非オブジェクト raw は空マップを返す', () => {
    expect(parseFieldOverrides(null)).toEqual({})
    expect(parseFieldOverrides(undefined)).toEqual({})
    expect(parseFieldOverrides('str')).toEqual({})
    expect(parseFieldOverrides(42)).toEqual({})
  })

  it('value が null や非オブジェクトのキーはスキップ', () => {
    expect(parseFieldOverrides({ a: null, b: 'x', c: { x: 1 } })).toEqual({
      c: { x: 1 },
    })
  })
})

describe('applyFieldOverride', () => {
  it('undefined override は元 field をそのまま返す（参照同一）', () => {
    const f = makeField()
    expect(applyFieldOverride(f, undefined)).toBe(f)
  })

  it('空 override も元 field をそのまま返す（参照同一）', () => {
    const f = makeField()
    expect(applyFieldOverride(f, {})).toBe(f)
  })

  it('x/y のみ override で bbox を差替・w/h/font.size はテンプレ既定保持', () => {
    const f = makeField()
    const out = applyFieldOverride(f, { x: 50, y: 60 })
    expect(out.bbox).toEqual({ page: 1, x: 50, y: 60, w: 300, h: 24 })
    expect(out.font.size).toBe(11)
  })

  it('fontSize override で font.size のみ差替・bbox はテンプレ既定保持', () => {
    const f = makeField()
    const out = applyFieldOverride(f, { fontSize: 14 })
    expect(out.bbox).toEqual({ page: 1, x: 100, y: 200, w: 300, h: 24 })
    expect(out.font.size).toBe(14)
    // family は維持
    expect(out.font.family).toBe('NotoSansJP')
  })

  it('フル override は bbox 全差替 + font.size 差替', () => {
    const f = makeField()
    const out = applyFieldOverride(f, {
      x: 10,
      y: 20,
      w: 400,
      h: 50,
      fontSize: 16,
    })
    expect(out.bbox).toEqual({ page: 1, x: 10, y: 20, w: 400, h: 50 })
    expect(out.font.size).toBe(16)
  })
})

describe('applyBboxOverrides', () => {
  it('overrides に対象 field が無ければそのまま', () => {
    const fs = [makeField({ name: 'a' }), makeField({ name: 'b' })]
    const out = applyBboxOverrides(fs, { c: { x: 1, y: 2 } })
    expect(out[0]).toBe(fs[0])
    expect(out[1]).toBe(fs[1])
  })

  it('旧 {x,y} のみ override も新 partial も両方適用（後方互換）', () => {
    const fs = [
      makeField({ name: 'old' }),
      makeField({ name: 'new', bbox: { page: 1, x: 0, y: 0, w: 100, h: 20 } }),
    ]
    const out = applyBboxOverrides(fs, {
      old: { x: 5, y: 5 },
      new: { x: 1, y: 1, w: 200, h: 40, fontSize: 13 },
    })
    expect(out[0].bbox).toEqual({ page: 1, x: 5, y: 5, w: 300, h: 24 })
    expect(out[0].font.size).toBe(11) // テンプレ既定
    expect(out[1].bbox).toEqual({ page: 1, x: 1, y: 1, w: 200, h: 40 })
    expect(out[1].font.size).toBe(13)
  })

  it('raw が null / 不正なら元配列をそのまま返す', () => {
    const fs = [makeField()]
    expect(applyBboxOverrides(fs, null)).toBe(fs)
    expect(applyBboxOverrides(fs, undefined)).toBe(fs)
    expect(applyBboxOverrides(fs, 'no')).toBe(fs)
  })

  it('全 override が parse で除外された場合も元配列を返す', () => {
    const fs = [makeField()]
    // 全フィールドが NaN だけの override は parseFieldOverrides で {} になる。
    expect(applyBboxOverrides(fs, { sample: { x: Number.NaN } })).toBe(fs)
  })
})
