/**
 * AdjustView 「項目を追加」UI 振る舞い unit test
 * （templates `handleAddField` 1:1 移植の回帰防止）。
 *
 * 追加ロジックは AdjustView 内のクロージャに閉じているが、**core 純関数**だけは pure に
 * 検証可能（nextClientFieldName / placeholderLabel / centeredNewBbox / payload 構築）。
 *
 * 検証観点:
 *   - nextClientFieldName: 既存 fields との name 衝突回避（field_N 形式採番）
 *   - placeholderLabel: 「項目N」仮置き文言（templates 同一）
 *   - centeredNewBbox: pageMeta 中央配置（templates 同関数を共有）
 *   - newFields payload 構築: newFieldNames 集合だけ抽出 + PdfField 既定属性補完
 *   - 「項目を追加」snapshot: fields / values / newFieldNames 同時追加（戻るで完全復元）
 */
import { describe, it, expect } from 'vitest'
import type { TemplateFieldDef } from '@/app/(dashboard)/minutes/[id]/adjust/AdjustView'
import {
  buildPdfFieldFromDefaults,
  nextClientFieldName,
  placeholderLabel,
} from '@/lib/pdf-output/bbox-save'
import { centeredNewBbox } from '@/lib/pdf-output/bbox-coords'
import type { BboxOverrides } from '@/lib/pdf-output/field-override'
import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'
import type { PageMeta } from '@/lib/pdf-output/bbox-coords'

// AdjustView 段階 2.5b の snapshot 構造（fields/values/overrides + newFieldNames）。
type AddFieldSnapshot = {
  fields: TemplateFieldDef[]
  values: Record<string, string>
  overrides: BboxOverrides
  newFieldNames: Set<string>
}

function makeField(name: string, h = 24): TemplateFieldDef {
  return {
    name,
    label: `項目${name}`,
    bbox: { x: 10, y: 10, w: 100, h },
  }
}

function makeMeta(): PageMeta {
  return {
    page: 1,
    widthPt: 595,
    heightPt: 842,
    pixelWidth: 595,
    pixelHeight: 842,
  }
}

/**
 * AdjustView の `handleAddField` 中核を純関数化（templates 1:1 移植部分のみ）。
 *   - name 衝突回避（既存 + 過去 newField を used に入れる）
 *   - bbox = centeredNewBbox
 *   - newFieldNames に追加 / values に空文字 init
 */
function addField(
  snap: AddFieldSnapshot,
  meta: PageMeta,
): AddFieldSnapshot {
  const used = new Set(snap.fields.map((f) => f.name))
  const name = nextClientFieldName(used)
  const bb = centeredNewBbox(meta)
  const newField: TemplateFieldDef = {
    name,
    label: placeholderLabel(snap.fields.length),
    bbox: { x: bb.x, y: bb.y, w: bb.w, h: bb.h },
    multiline: false,
  }
  const nextNames = new Set(snap.newFieldNames)
  nextNames.add(name)
  return {
    fields: [...snap.fields, newField],
    values: { ...snap.values, [name]: '' },
    overrides: snap.overrides,
    newFieldNames: nextNames,
  }
}

/**
 * AdjustView の `buildNewFieldsPayload` と同一ロジック（onSave 直前で呼ばれる）。
 *   - newFieldNames 集合の field だけ抽出
 *   - PdfField 全プロパティ既定補完（buildPdfFieldFromDefaults）
 */
function buildNewFieldsPayload(
  snap: AddFieldSnapshot,
  pageNumber: number,
): PdfField[] {
  const out: PdfField[] = []
  for (const f of snap.fields) {
    if (!snap.newFieldNames.has(f.name)) continue
    out.push(
      buildPdfFieldFromDefaults({
        name: f.name,
        label: f.label,
        bbox: {
          page: pageNumber,
          x: f.bbox.x,
          y: f.bbox.y,
          w: f.bbox.w,
          h: f.bbox.h,
        },
        multiline: f.multiline ?? false,
      }),
    )
  }
  return out
}

describe('項目追加の name 採番', () => {
  it('既存 fields が空なら field_1 を採番する', () => {
    const name = nextClientFieldName(new Set())
    expect(name).toBe('field_1')
  })

  it('既存 fields と衝突しない最小の field_N を採番する', () => {
    const used = new Set(['field_1', 'field_2', 'foo'])
    expect(nextClientFieldName(used)).toBe('field_3')
  })

  it('飛び番（field_1, field_3）があれば穴埋めする', () => {
    const used = new Set(['field_1', 'field_3'])
    expect(nextClientFieldName(used)).toBe('field_2')
  })

  it('既存 fields の name は a-z 以外（greeting 等）でも衝突回避される', () => {
    const used = new Set(['greeting', 'agenda', 'note'])
    expect(nextClientFieldName(used)).toBe('field_1')
  })
})

describe('項目追加の placeholderLabel', () => {
  it('既存 0 件なら「項目1」を返す（templates 同形式）', () => {
    expect(placeholderLabel(0)).toBe('項目1')
  })

  it('既存 3 件なら「項目4」を返す', () => {
    expect(placeholderLabel(3)).toBe('項目4')
  })
})

describe('項目追加の snapshot 構造', () => {
  it('追加で fields / values / newFieldNames が同時に更新される', () => {
    const before: AddFieldSnapshot = {
      fields: [makeField('greeting'), makeField('agenda')],
      values: { greeting: 'こんにちは', agenda: '' },
      overrides: {},
      newFieldNames: new Set(),
    }
    const after = addField(before, makeMeta())

    // 末尾追加（順序維持・templates 同方式）
    expect(after.fields.map((f) => f.name)).toEqual([
      'greeting',
      'agenda',
      'field_1',
    ])
    // 新 field の値は空文字 init
    expect(after.values.field_1).toBe('')
    // 既存値は不変
    expect(after.values.greeting).toBe('こんにちは')
    // newFieldNames に追加
    expect(after.newFieldNames.has('field_1')).toBe(true)
    expect(after.newFieldNames.size).toBe(1)
    // overrides は触らない（fontSize ± / position drag は別経路）
    expect(after.overrides).toEqual({})
  })

  it('連続追加で field_1 → field_2 → field_3 と採番される', () => {
    let snap: AddFieldSnapshot = {
      fields: [makeField('a')],
      values: { a: '' },
      overrides: {},
      newFieldNames: new Set(),
    }
    snap = addField(snap, makeMeta())
    snap = addField(snap, makeMeta())
    snap = addField(snap, makeMeta())
    expect(snap.fields.map((f) => f.name)).toEqual([
      'a',
      'field_1',
      'field_2',
      'field_3',
    ])
    expect(snap.newFieldNames.size).toBe(3)
  })

  it('追加した field の bbox は centeredNewBbox（pageMeta 中央配置）', () => {
    const before: AddFieldSnapshot = {
      fields: [],
      values: {},
      overrides: {},
      newFieldNames: new Set(),
    }
    const meta = makeMeta()
    const after = addField(before, meta)
    const added = after.fields[0]
    // 中央配置: x = (widthPt - w) / 2, y = (heightPt - h) / 2
    const expected = centeredNewBbox(meta)
    expect(added.bbox.x).toBeCloseTo(expected.x, 5)
    expect(added.bbox.y).toBeCloseTo(expected.y, 5)
    expect(added.bbox.w).toBeCloseTo(expected.w, 5)
    expect(added.bbox.h).toBeCloseTo(expected.h, 5)
  })
})

describe('項目追加 → onSave で newFields payload 構築', () => {
  it('newFieldNames 集合だけ payload に含まれる（既存 field は含まれない）', () => {
    const snap: AddFieldSnapshot = {
      fields: [
        makeField('greeting'),
        makeField('field_1'),
        makeField('field_2'),
      ],
      values: { greeting: 'こんにちは', field_1: 'a', field_2: 'b' },
      overrides: {},
      // 既存 greeting は newFieldNames に含めない
      newFieldNames: new Set(['field_1', 'field_2']),
    }
    const payload = buildNewFieldsPayload(snap, 1)
    expect(payload).toHaveLength(2)
    expect(payload.map((p) => p.name)).toEqual(['field_1', 'field_2'])
    // 既存 greeting は payload から除外
    expect(payload.some((p) => p.name === 'greeting')).toBe(false)
  })

  it('newFieldNames が空なら payload も空配列', () => {
    const snap: AddFieldSnapshot = {
      fields: [makeField('greeting'), makeField('agenda')],
      values: { greeting: '', agenda: '' },
      overrides: {},
      newFieldNames: new Set(),
    }
    expect(buildNewFieldsPayload(snap, 1)).toEqual([])
  })

  it('payload の各 field は PdfField スキーマ既定値を補完（type/max_chars/font/padding/...）', () => {
    const snap: AddFieldSnapshot = {
      fields: [makeField('field_1')],
      values: { field_1: '' },
      overrides: {},
      newFieldNames: new Set(['field_1']),
    }
    const payload = buildNewFieldsPayload(snap, 1)
    const p = payload[0]
    // buildPdfFieldFromDefaults の補完が効いていること（bbox-save.ts NEW_FIELD_DEFAULTS）
    expect(p.type).toBe('text')
    expect(p.max_chars).toBe(100)
    expect(p.font.family).toBe('NotoSansJP')
    expect(p.padding).toEqual({ left: 4, top: 4, right: 4, bottom: 4 })
    expect(p.multiline).toBe(false)
    // bbox.page は呼出側で渡した値
    expect(p.bbox.page).toBe(1)
  })

  it('追加 → 即座に削除（newFieldNames から消す）すると payload に含まれない（2.5c 整合）', () => {
    const snap: AddFieldSnapshot = {
      fields: [makeField('greeting'), makeField('field_1')],
      values: { greeting: '', field_1: '' },
      overrides: {},
      // field_1 は追加されたが、削除で newFieldNames からも消えた状態
      newFieldNames: new Set(),
    }
    const payload = buildNewFieldsPayload(snap, 1)
    expect(payload).toEqual([])
  })
})

describe('項目追加の既存 fields との name 衝突回避', () => {
  it('既存 fields に field_1 / field_2 がある場合、新 field は field_3 から採番', () => {
    const before: AddFieldSnapshot = {
      fields: [makeField('field_1'), makeField('field_2'), makeField('agenda')],
      values: { field_1: '', field_2: '', agenda: '' },
      overrides: {},
      newFieldNames: new Set(),
    }
    const after = addField(before, makeMeta())
    expect(after.fields[after.fields.length - 1].name).toBe('field_3')
  })

  it('templates 由来の field_1（DB 既存）と同 name で衝突しない', () => {
    // mergeTemplateAndNewFields がサーバ側でも衝突再採番するが、
    // クライアント側でも nextClientFieldName で楽観回避する。
    const before: AddFieldSnapshot = {
      fields: [makeField('field_1')], // templates 由来の field_1
      values: { field_1: '' },
      overrides: {},
      newFieldNames: new Set(),
    }
    const after = addField(before, makeMeta())
    const newOne = after.fields[after.fields.length - 1]
    expect(newOne.name).toBe('field_2')
    expect(after.newFieldNames.has('field_2')).toBe(true)
    expect(after.newFieldNames.has('field_1')).toBe(false)
  })
})
