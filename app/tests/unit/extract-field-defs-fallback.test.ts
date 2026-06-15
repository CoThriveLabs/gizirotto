import { describe, it, expect } from 'vitest'

/**
 * extractFieldDefs の bboxFallback 仕様を凍結するテスト。
 *
 * 前提: src/app/(dashboard)/minutes/[id]/adjust/page.tsx の extractFieldDefs は
 * **template.fields を反復源**とし、bboxFallback は「対応 entry の x/y/w/h が欠落
 * していた場合の補完」専用である。template.fields 側に name 自体が存在しないと、
 * bboxFallback にいくら座標があっても新規 entry として追加される経路は無い。
 *
 * 以前にシードされた本番クラウド DB の builtin 3 行は fields jsonb が旧 5 件版
 * （discussion 抜き）で固着していたため、bbox JSON / bbox_overrides に discussion 座標が
 * 揃っていても AdjustView では永遠に描画されなかった。
 *
 *   負例（ケース A）: template.fields = 5 件版 → out.length === 5
 *     （discussion がフォールバックで自動追加されないことを明示）
 *   正例（ケース B）: template.fields = 6 件版 → out.length === 6 かつ discussion を含む
 *
 * このテストは「extractFieldDefs ロジックを将来変えない」凍結用ではなく、
 * 「DB の fields jsonb 側に discussion を含める運用を維持する」ためのレッドフラグ。
 * もし将来 extractFieldDefs を「fallback の name を新規 entry として吸い上げる」
 * 方向に拡張する場合は、本テスト負例を意図的に書き換えて意思を残すこと。
 *
 * 実装ノート: page.tsx の extractFieldDefs は server-only モジュールへの依存
 * （next/headers 等）を経由せず存在するが、page.tsx 自体が server component なので
 * vitest からの直接 import は不安定。同等ロジックを本ファイルに複製して検証する
 * （page.tsx 側の真の関数とは同期で守ること）。
 */

type TemplateFieldDef = {
  name: string
  label: string
  bbox: { x: number; y: number; w: number; h: number }
  multiline: boolean
}

function extractFieldDefs(
  raw: unknown,
  bboxFallback?: Record<string, { x: number; y: number; w: number; h: number }>,
): TemplateFieldDef[] {
  if (!raw) return []
  const fieldsArr: unknown = Array.isArray(raw)
    ? raw
    : typeof raw === 'object'
      ? (raw as { fields?: unknown }).fields
      : null
  if (!Array.isArray(fieldsArr)) return []
  const out: TemplateFieldDef[] = []
  for (const f of fieldsArr) {
    if (!f || typeof f !== 'object') continue
    const obj = f as Record<string, unknown>
    const name = typeof obj.name === 'string' ? obj.name : null
    if (!name) continue
    const bbox = obj.bbox as Record<string, unknown> | undefined
    let x: number | null = null
    let y: number | null = null
    let w = 100
    let h = 20
    if (bbox) {
      x = typeof bbox.x === 'number' ? bbox.x : null
      y = typeof bbox.y === 'number' ? bbox.y : null
      w = typeof bbox.w === 'number' ? bbox.w : 100
      h = typeof bbox.h === 'number' ? bbox.h : 20
    }
    if ((x === null || y === null) && bboxFallback && bboxFallback[name]) {
      const fb = bboxFallback[name]
      x = fb.x
      y = fb.y
      w = fb.w
      h = fb.h
    }
    if (x === null || y === null) continue
    const multiline =
      typeof obj.multiline === 'boolean' ? obj.multiline : false
    out.push({
      name,
      label:
        typeof obj.label_ja === 'string'
          ? obj.label_ja
          : typeof obj.label === 'string'
            ? obj.label
            : name,
      bbox: { x, y, w, h },
      multiline,
    })
  }
  return out
}

const DISCUSSION_BBOX = {
  x: 189.6875,
  y: 456.015625,
  w: 352.8125,
  h: 223.84375,
}

/** 家計報告の旧固着状態を再現した DB fields（discussion 抜き 5 件版）。 */
const BUDGET_FIELDS_LEGACY_5 = [
  { name: 'month', label: '月度', type: 'text', required: true },
  { name: 'income', label: '収入', type: 'text', required: true },
  { name: 'expense', label: '支出', type: 'text', required: true },
  { name: 'savings', label: '貯蓄', type: 'text', required: false },
  { name: 'next_plan', label: '次月予定', type: 'list', required: false },
]

/** migration 適用後の正しい状態（discussion 末尾追記 6 件版）。 */
const BUDGET_FIELDS_PATCHED_6 = [
  ...BUDGET_FIELDS_LEGACY_5,
  { name: 'discussion', label: '議事内容', type: 'list', required: false },
]

/**
 * adjust/page.tsx の bboxFallbackForFields 実機構築結果を再現したダミー bbox。
 * builtin/budget-report.bbox.json の 6 件分（month/income/expense/savings/next_plan/discussion）を
 * createMinute で minute.bbox_overrides に焼き込み → AdjustView の bboxFallback として
 * 全 6 件分の座標が渡る、というのが createMinute 以降の実機経路。
 *
 * 本テストでは座標値の正確性は問わない（builtin-discussion-bbox-roundtrip.test.ts で別途検証）。
 * 「全 field 名が fallback 側に揃っているのに、template.fields 側に名前が無いだけで脱落する」
 * という真因シナリオを最小再現することが目的。
 */
const FULL_BBOX_FALLBACK_6: Record<
  string,
  { x: number; y: number; w: number; h: number }
> = {
  month: { x: 100, y: 100, w: 200, h: 30 },
  income: { x: 100, y: 150, w: 200, h: 30 },
  expense: { x: 100, y: 200, w: 200, h: 30 },
  savings: { x: 100, y: 250, w: 200, h: 30 },
  next_plan: { x: 100, y: 300, w: 200, h: 30 },
  discussion: DISCUSSION_BBOX,
}

describe('extractFieldDefs × bboxFallback 仕様凍結', () => {
  it('ケース A 負例: fields 側に discussion 名が無ければ fallback だけでは新規追加されない', () => {
    // 真因シナリオ: bboxFallback に discussion 座標が揃っていても、
    // DB の template.fields 側 entry が無いと extractFieldDefs の反復に乗らない。
    const out = extractFieldDefs(BUDGET_FIELDS_LEGACY_5, FULL_BBOX_FALLBACK_6)
    expect(
      out.length,
      'discussion が fallback だけで吸い上げられたら本テストは壊れる',
    ).toBe(5)
    expect(out.find((o) => o.name === 'discussion')).toBeUndefined()
    expect(out.map((o) => o.name)).toEqual([
      'month',
      'income',
      'expense',
      'savings',
      'next_plan',
    ])
  })

  it('ケース B 正例: fields 側に discussion 名があれば fallback で座標が補完される', () => {
    // migration 適用後シナリオ: DB に entry が増えれば fallback 座標が貼り付く。
    const out = extractFieldDefs(BUDGET_FIELDS_PATCHED_6, FULL_BBOX_FALLBACK_6)
    expect(out.length).toBe(6)
    const discussion = out.find((o) => o.name === 'discussion')
    expect(discussion).toBeDefined()
    expect(discussion!.bbox).toEqual(DISCUSSION_BBOX)
    expect(discussion!.label).toBe('議事内容')
  })

  it('ケース B 派生: fields に bbox が直接付与済なら fallback は使われない', () => {
    const directBbox = { x: 10, y: 20, w: 30, h: 40 }
    const fields = [
      ...BUDGET_FIELDS_LEGACY_5,
      {
        name: 'discussion',
        label: '議事内容',
        type: 'list',
        required: false,
        bbox: directBbox,
      },
    ]
    const out = extractFieldDefs(fields, FULL_BBOX_FALLBACK_6)
    const discussion = out.find((o) => o.name === 'discussion')
    expect(discussion!.bbox).toEqual(directBbox)
  })
})
