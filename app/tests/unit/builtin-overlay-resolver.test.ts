/**
 * builtin 用 effectiveFields 構築 pure 関数 `buildBuiltinEffectiveFields` の unit test。
 *
 * 補完優先順位（dbOverrides > tplBbox > fallbackFromJson）の式を固定する。
 *
 * 実機シナリオ:
 *   - builtin で seed.sql の fields jsonb は bbox を持たない
 *   - 初期 bbox は public/builtin-templates/{slug}.bbox.json から読まれる
 *   - ユーザーが AdjustView で位置調整すると bbox_overrides に差分が入る
 *   - 詳細画面 render-image / サムネ生成の builtin 経路はこの 3 層を合流して描画位置を解決する
 */
import { describe, it, expect } from 'vitest'
import {
  buildBuiltinEffectiveFields,
  type BuiltinBboxJsonEntry,
} from '@/lib/pdf-output/builtin-overlay-resolver'
import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'
import type { FieldOverride } from '@/lib/pdf-output/field-override'

function tf(name: string, bbox?: Partial<{ x: number; y: number; w: number; h: number }>): PdfField {
  return {
    name,
    label: name,
    type: 'text',
    bbox: { page: 1, x: bbox?.x ?? (NaN as unknown as number), y: bbox?.y ?? (NaN as unknown as number), w: bbox?.w ?? (NaN as unknown as number), h: bbox?.h ?? (NaN as unknown as number) },
    max_chars: 200,
    font: { family: 'NotoSansJP', size: 12 },
    multiline: false,
    font_size_min: 8,
    padding: { left: 4, top: 4, right: 4, bottom: 4 },
  } as PdfField
}

/**
 * builtin の templates.fields は seed.sql で bbox プロパティ自体を持たない
 * （family_meeting / child_schedule / budget_report いずれも）。実 runtime で
 * `tf.bbox === undefined` になる経路を厳密にエミュレートするヘルパ。
 * 既存 `tf()` は型を満たすため bbox を必ず付けてしまい、bbox 完全欠落を再現できない。
 */
function tfNoBbox(name: string): PdfField {
  return {
    name,
    label: name,
    type: 'text',
    // bbox を意図的に省略（builtin seed.sql 実態を再現）。
    max_chars: 200,
    font: { family: 'NotoSansJP', size: 12 },
    multiline: false,
    font_size_min: 8,
    padding: { left: 4, top: 4, right: 4, bottom: 4 },
  } as unknown as PdfField
}

/**
 * builtin の templates.fields jsonb は bbox 以外の PdfField 必須属性も持たない実態
 * （seed.sql 参照: `{name, label, type, required}` のみ）。
 * font / padding / max_chars / multiline / font_size_min がすべて undefined。
 * そのまま image-renderer に渡すと undefined 参照 throw → 詳細画面で値が見えない。
 * `buildBuiltinEffectiveFields` 内の `buildPdfFieldFromDefaults` 補完で救う。
 */
function tfSeedMinimal(name: string, label = name): PdfField {
  return {
    name,
    label,
    type: 'text',
    // builtin seed.sql の実態: bbox / font / padding / max_chars / multiline /
    // font_size_min / align / vertical 等を持たない。
  } as unknown as PdfField
}

describe('buildBuiltinEffectiveFields', () => {
  it('実機シナリオ: builtin tplFields は bbox 欠落・fallbackFromJson から x/y/w/h を補完できる', () => {
    const tplFields: PdfField[] = [tf('place')]
    const dbOverrides: Record<string, FieldOverride> = {}
    const fallbackFromJson: Record<string, BuiltinBboxJsonEntry> = {
      place: { x: 189, y: 181, w: 352, h: 69 },
    }
    const out = buildBuiltinEffectiveFields({ tplFields, dbOverrides, fallbackFromJson })
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('place')
    expect(out[0].bbox).toMatchObject({ x: 189, y: 181, w: 352, h: 69, page: 1 })
  })

  it('dbOverrides が fallback より優先される（ユーザー編集差分尊重）', () => {
    const tplFields: PdfField[] = [tf('place')]
    const dbOverrides: Record<string, FieldOverride> = {
      place: { x: 300, y: 400 }, // ユーザーが動かした位置
    }
    const fallbackFromJson: Record<string, BuiltinBboxJsonEntry> = {
      place: { x: 189, y: 181, w: 352, h: 69 }, // builtin 初期
    }
    const out = buildBuiltinEffectiveFields({ tplFields, dbOverrides, fallbackFromJson })
    expect(out[0].bbox).toMatchObject({ x: 300, y: 400, w: 352, h: 69, page: 1 })
  })

  it('tplBbox（テンプレ素値）が fallback より優先される（user テンプレ系の互換）', () => {
    const tplFields: PdfField[] = [tf('place', { x: 100, y: 100, w: 200, h: 30 })]
    const dbOverrides: Record<string, FieldOverride> = {}
    const fallbackFromJson: Record<string, BuiltinBboxJsonEntry> = {
      place: { x: 999, y: 999, w: 999, h: 999 },
    }
    const out = buildBuiltinEffectiveFields({ tplFields, dbOverrides, fallbackFromJson })
    expect(out[0].bbox).toMatchObject({ x: 100, y: 100, w: 200, h: 30 })
  })

  it('優先順は軸単位: x のみ override・w/h は fallback など混在可能', () => {
    const tplFields: PdfField[] = [tf('place')]
    const dbOverrides: Record<string, FieldOverride> = {
      place: { x: 300 }, // x だけ動かした
    }
    const fallbackFromJson: Record<string, BuiltinBboxJsonEntry> = {
      place: { x: 189, y: 181, w: 352, h: 69 },
    }
    const out = buildBuiltinEffectiveFields({ tplFields, dbOverrides, fallbackFromJson })
    expect(out[0].bbox).toMatchObject({ x: 300, y: 181, w: 352, h: 69 })
  })

  it('bbox 4 軸のうち 1 つでも解決できない field はスキップされる（座標誤焼き込み回避）', () => {
    const tplFields: PdfField[] = [tf('a'), tf('b')]
    const dbOverrides: Record<string, FieldOverride> = {}
    const fallbackFromJson: Record<string, BuiltinBboxJsonEntry> = {
      a: { x: 1, y: 2, w: 3, h: 4 },
      // b は fallback にも無い → bbox 解決不能 → スキップ
    }
    const out = buildBuiltinEffectiveFields({ tplFields, dbOverrides, fallbackFromJson })
    expect(out.map((f) => f.name)).toEqual(['a'])
  })

  it('fallbackFromJson が null でも tplBbox があれば解決できる', () => {
    const tplFields: PdfField[] = [tf('place', { x: 50, y: 60, w: 100, h: 20 })]
    const out = buildBuiltinEffectiveFields({
      tplFields,
      dbOverrides: {},
      fallbackFromJson: null,
    })
    expect(out[0].bbox).toMatchObject({ x: 50, y: 60, w: 100, h: 20 })
  })

  it('全 fields が解決不能なら空配列を返す（throw しない）', () => {
    const tplFields: PdfField[] = [tf('orphan')]
    const out = buildBuiltinEffectiveFields({
      tplFields,
      dbOverrides: {},
      fallbackFromJson: null,
    })
    expect(out).toEqual([])
  })

  it('bbox.page は常に 1 に固定される（builtin 1 ページ前提）', () => {
    const tplFields: PdfField[] = [tf('a')]
    const out = buildBuiltinEffectiveFields({
      tplFields,
      dbOverrides: { a: { x: 1, y: 2, w: 3, h: 4 } },
      fallbackFromJson: null,
    })
    expect(out[0].bbox.page).toBe(1)
  })

  // builtin の templates.fields は seed.sql で bbox プロパティ自体を持たない
  // ため `tf.bbox === undefined` で TypeError を踏む。null 安全化の回帰防止。
  it('tf.bbox === undefined（builtin 典型）+ dbOverrides あり → dbOverrides で解決', () => {
    const tplFields: PdfField[] = [tfNoBbox('place')]
    const dbOverrides: Record<string, FieldOverride> = {
      place: { x: 100, y: 200, w: 300, h: 40 },
    }
    const out = buildBuiltinEffectiveFields({
      tplFields,
      dbOverrides,
      fallbackFromJson: null,
    })
    expect(out).toHaveLength(1)
    expect(out[0].bbox).toMatchObject({ x: 100, y: 200, w: 300, h: 40, page: 1 })
  })

  it('tf.bbox === undefined + dbOverrides なし + fallbackJson あり → fallback で解決', () => {
    const tplFields: PdfField[] = [tfNoBbox('place')]
    const fallbackFromJson: Record<string, BuiltinBboxJsonEntry> = {
      place: { x: 189, y: 181, w: 352, h: 69 },
    }
    const out = buildBuiltinEffectiveFields({
      tplFields,
      dbOverrides: {},
      fallbackFromJson,
    })
    expect(out).toHaveLength(1)
    expect(out[0].bbox).toMatchObject({ x: 189, y: 181, w: 352, h: 69, page: 1 })
  })

  it('tf.bbox === undefined + dbOverrides なし + fallbackJson なし → field スキップ', () => {
    const tplFields: PdfField[] = [tfNoBbox('orphan')]
    const out = buildBuiltinEffectiveFields({
      tplFields,
      dbOverrides: {},
      fallbackFromJson: null,
    })
    expect(out).toEqual([])
  })

  it('bbox 欠落 fields でも throw せず通り抜ける（TypeError 500 回帰防止）', () => {
    const tplFields: PdfField[] = [
      tfNoBbox('attendees'),
      tfNoBbox('agenda'),
      tfNoBbox('discussion'),
      tfNoBbox('decisions'),
      tfNoBbox('todos'),
    ]
    // 実機シナリオ: builtin 家族会議の DB content_json は値あり、bbox は初期焼き込み済
    const dbOverrides: Record<string, FieldOverride> = {
      attendees: { x: 189, y: 181, w: 352, h: 69 },
      todos: { x: 189, y: 647, w: 352, h: 100 },
    }
    const fallbackFromJson: Record<string, BuiltinBboxJsonEntry> = {
      agenda: { x: 189, y: 251, w: 352, h: 100 },
      discussion: { x: 189, y: 351, w: 352, h: 226 },
      decisions: { x: 189, y: 578, w: 352, h: 69 },
    }
    expect(() =>
      buildBuiltinEffectiveFields({ tplFields, dbOverrides, fallbackFromJson }),
    ).not.toThrow()
    const out = buildBuiltinEffectiveFields({ tplFields, dbOverrides, fallbackFromJson })
    expect(out.map((f) => f.name)).toEqual([
      'attendees',
      'agenda',
      'discussion',
      'decisions',
      'todos',
    ])
  })

  // builtin の templates.fields は bbox 以外の PdfField 必須属性も欠落しているため、
  // そのまま image-renderer に渡すと内部 throw → bg.png サイレント退避していた。
  // buildPdfFieldFromDefaults 補完で必須属性を埋めることを担保する。
  it('tplFields が bbox 以外の必須属性を持たなくても、戻り PdfField は font/padding/max_chars 等を補完済', () => {
    const tplFields: PdfField[] = [tfSeedMinimal('place', '場所')]
    const fallbackFromJson: Record<string, BuiltinBboxJsonEntry> = {
      place: { x: 189, y: 181, w: 352, h: 78 },
    }
    const out = buildBuiltinEffectiveFields({
      tplFields,
      dbOverrides: {},
      fallbackFromJson,
    })
    expect(out).toHaveLength(1)
    const f = out[0]
    // bbox 解決
    expect(f.bbox).toMatchObject({ x: 189, y: 181, w: 352, h: 78, page: 1 })
    // PdfField 必須属性が補完されていること（image-renderer 内 throw を防ぐ）
    expect(f.font).toBeDefined()
    expect(typeof f.font.size).toBe('number')
    expect(f.font.size).toBeGreaterThan(0)
    expect(f.padding).toBeDefined()
    expect(typeof f.padding.left).toBe('number')
    expect(typeof f.padding.top).toBe('number')
    expect(typeof f.padding.right).toBe('number')
    expect(typeof f.padding.bottom).toBe('number')
    expect(typeof f.max_chars).toBe('number')
    expect(typeof f.multiline).toBe('boolean')
    expect(typeof f.font_size_min).toBe('number')
    // name / label は元の値を尊重
    expect(f.name).toBe('place')
    expect(f.label).toBe('場所')
  })

  it('tplFields に font / padding が既に入っていれば、その値が補完値より優先される（user テンプレ互換）', () => {
    const customField: PdfField = {
      name: 'custom',
      label: 'カスタム',
      type: 'text',
      max_chars: 500,
      font: { family: 'CustomFont', size: 14 },
      padding: { left: 10, top: 10, right: 10, bottom: 10 },
      multiline: true,
      font_size_min: 6,
    } as unknown as PdfField
    const fallbackFromJson: Record<string, BuiltinBboxJsonEntry> = {
      custom: { x: 100, y: 100, w: 200, h: 30 },
    }
    const out = buildBuiltinEffectiveFields({
      tplFields: [customField],
      dbOverrides: {},
      fallbackFromJson,
    })
    expect(out).toHaveLength(1)
    expect(out[0].font.size).toBe(14)
    expect(out[0].padding.left).toBe(10)
    expect(out[0].max_chars).toBe(500)
    expect(out[0].multiline).toBe(true)
    expect(out[0].font_size_min).toBe(6)
  })

  it('実機シナリオ: 子の予定 builtin 5 fields すべて seed 最小形 + bbox JSON fallback → 必須属性が全 5 件補完される', () => {
    const tplFields: PdfField[] = [
      tfSeedMinimal('place', '場所'),
      tfSeedMinimal('discussion', '議事内容'),
      tfSeedMinimal('items', '持ち物'),
      tfSeedMinimal('escort', '送迎担当'),
      tfSeedMinimal('notes', '注意事項'),
    ]
    const fallbackFromJson: Record<string, BuiltinBboxJsonEntry> = {
      place: { x: 189, y: 181, w: 352, h: 78 },
      discussion: { x: 189, y: 259, w: 352, h: 254 },
      items: { x: 189, y: 514, w: 352, h: 78 },
      escort: { x: 189, y: 592, w: 352, h: 78 },
      notes: { x: 189, y: 670, w: 352, h: 78 },
    }
    const out = buildBuiltinEffectiveFields({
      tplFields,
      dbOverrides: {},
      fallbackFromJson,
    })
    expect(out).toHaveLength(5)
    for (const f of out) {
      expect(f.font, `${f.name} font`).toBeDefined()
      expect(typeof f.font.size, `${f.name} font.size`).toBe('number')
      expect(f.padding, `${f.name} padding`).toBeDefined()
      expect(typeof f.padding.left, `${f.name} padding.left`).toBe('number')
      expect(typeof f.font_size_min, `${f.name} font_size_min`).toBe('number')
    }
  })

  it('NaN / Infinity は軸として無効・次の優先層に降りる', () => {
    const tplFields: PdfField[] = [tf('place', { x: NaN, y: Infinity, w: 100, h: 20 })]
    const out = buildBuiltinEffectiveFields({
      tplFields,
      dbOverrides: {},
      fallbackFromJson: { place: { x: 50, y: 60, w: 999, h: 999 } },
    })
    // x, y は NaN/Infinity で無効 → fallback に降りる。w, h は tplBbox 有効 → 採用。
    expect(out[0].bbox).toMatchObject({ x: 50, y: 60, w: 100, h: 20 })
  })
})
