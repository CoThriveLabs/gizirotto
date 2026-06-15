import { describe, it, expect } from 'vitest'
import {
  mergeBboxUpdates,
  mergeFieldsSnapshot,
  pickBboxFields,
  BboxUpdatePayloadSchema,
  FieldsSnapshotPayloadSchema,
  NEW_FIELD_DEFAULTS,
  type FieldSnapshotItem,
} from '@/lib/pdf-output/bbox-save'
import {
  stableStringify,
  computeFieldsVersion,
} from '@/lib/pdf-output/fields-version'
import type { PageMeta } from '@/lib/pdf-output/bbox-coords'

const PAGES: PageMeta[] = [
  { page: 1, widthPt: 595, heightPt: 842, pixelWidth: 1190, pixelHeight: 1684 },
]

// 現 DB fields の例（bbox 付き PDF field + 他属性温存対象）。
function dbFields() {
  return [
    {
      name: 'meeting_date',
      label: '会議日',
      type: 'date',
      bbox: { page: 1, x: 100, y: 100, w: 80, h: 20 },
      max_chars: 10,
      font: { family: 'NotoSansJP', size: 11 },
      padding: { left: 4, top: 4, right: 4, bottom: 4 },
    },
    {
      name: 'topic',
      label: '議題',
      type: 'text',
      bbox: { page: 1, x: 100, y: 200, w: 300, h: 40 },
      max_chars: 200,
      font: { family: 'NotoSansJP', size: 11 },
    },
  ]
}

describe('fields-version', () => {
  it('stableStringify はキー順非依存で同じ文字列', () => {
    const a = { x: 1, y: 2, z: { b: 1, a: 2 } }
    const b = { z: { a: 2, b: 1 }, y: 2, x: 1 }
    expect(stableStringify(a)).toBe(stableStringify(b))
  })

  it('配列順序は保持する（fields 並び順は意味を持つ）', () => {
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]))
  })

  it('computeFieldsVersion は同入力で安定、bbox 変化で変わる', () => {
    const v1 = computeFieldsVersion(dbFields())
    const v2 = computeFieldsVersion(dbFields())
    expect(v1).toBe(v2)
    const mutated = dbFields()
    mutated[0].bbox.x = 999
    expect(computeFieldsVersion(mutated)).not.toBe(v1)
  })
})

describe('mergeBboxUpdates 正常系', () => {
  it('bbox を差替え、他属性（label/font/padding）を温存', () => {
    const updates = [
      { name: 'meeting_date', bbox: { page: 1, x: 120, y: 110, w: 90, h: 22 } },
      { name: 'topic', bbox: { page: 1, x: 100, y: 200, w: 300, h: 40 } },
    ]
    const r = mergeBboxUpdates(dbFields(), updates, PAGES)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const md = r.fields.find((f) => f.name === 'meeting_date')!
    expect(md.bbox).toEqual({ page: 1, x: 120, y: 110, w: 90, h: 22 })
    // 他属性温存。
    expect(md.label).toBe('会議日')
    expect(md.max_chars).toBe(10)
    expect((md.font as { size: number }).size).toBe(11)
    expect(md.padding).toEqual({ left: 4, top: 4, right: 4, bottom: 4 })
  })

  it('dbFields の並び順を保持', () => {
    const updates = [
      { name: 'topic', bbox: { page: 1, x: 100, y: 200, w: 300, h: 40 } },
      { name: 'meeting_date', bbox: { page: 1, x: 100, y: 100, w: 80, h: 20 } },
    ]
    const r = mergeBboxUpdates(dbFields(), updates, PAGES)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.fields.map((f) => f.name)).toEqual(['meeting_date', 'topic'])
  })
})

describe('mergeBboxUpdates バリデーション', () => {
  it('name 集合不一致（欠落）はエラー', () => {
    const updates = [
      { name: 'meeting_date', bbox: { page: 1, x: 100, y: 100, w: 80, h: 20 } },
    ]
    const r = mergeBboxUpdates(dbFields(), updates, PAGES)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('NAME_SET_MISMATCH')
  })

  it('name 集合不一致（未知名追加）はエラー', () => {
    const updates = [
      { name: 'meeting_date', bbox: { page: 1, x: 100, y: 100, w: 80, h: 20 } },
      { name: 'topic', bbox: { page: 1, x: 100, y: 200, w: 300, h: 40 } },
      { name: 'ghost', bbox: { page: 1, x: 0, y: 0, w: 10, h: 10 } },
    ]
    const r = mergeBboxUpdates(dbFields(), updates, PAGES)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('NAME_SET_MISMATCH')
  })

  it('範囲外 bbox（x+w > widthPt）はエラー', () => {
    const updates = [
      { name: 'meeting_date', bbox: { page: 1, x: 550, y: 100, w: 100, h: 20 } },
      { name: 'topic', bbox: { page: 1, x: 100, y: 200, w: 300, h: 40 } },
    ]
    const r = mergeBboxUpdates(dbFields(), updates, PAGES)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('BBOX_OUT_OF_RANGE')
  })

  it('存在しない page はエラー', () => {
    const updates = [
      { name: 'meeting_date', bbox: { page: 9, x: 100, y: 100, w: 80, h: 20 } },
      { name: 'topic', bbox: { page: 1, x: 100, y: 200, w: 300, h: 40 } },
    ]
    const r = mergeBboxUpdates(dbFields(), updates, PAGES)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('PAGE_NOT_FOUND')
  })

  it('zod: w<=0 は payload バリデーションで弾く（h も同様に number 必須）', () => {
    const bad = [
      { name: 'meeting_date', bbox: { page: 1, x: 100, y: 100, w: 80 } },
    ]
    expect(BboxUpdatePayloadSchema.safeParse(bad).success).toBe(false)
  })

  it('bbox 無し field（docx 由来）が無ければ NO_BBOX_FIELDS', () => {
    const docxFields = [{ name: 'a', label: 'A', type: 'text' }]
    const r = mergeBboxUpdates(docxFields, [
      { name: 'a', bbox: { page: 1, x: 0, y: 0, w: 10, h: 10 } },
    ], PAGES)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('NO_BBOX_FIELDS')
  })
})

describe('pickBboxFields', () => {
  it('bbox を持つ field だけ抽出', () => {
    const mixed = [
      { name: 'a', label: 'A', type: 'text' },
      { name: 'b', label: 'B', type: 'text', bbox: { page: 1, x: 0, y: 0, w: 1, h: 1 } },
    ]
    expect(pickBboxFields(mixed).map((f) => f.name)).toEqual(['b'])
  })

  it('docx 由来 field を温存しつつ bbox field のみ差替（混在）', () => {
    const mixed: unknown[] = [
      { name: 'a', label: 'A', type: 'text' }, // bbox 無し
      {
        name: 'b',
        label: 'B',
        type: 'text',
        bbox: { page: 1, x: 0, y: 0, w: 10, h: 10 },
        max_chars: 50,
      },
    ]
    const r = mergeBboxUpdates(mixed, [
      { name: 'b', bbox: { page: 1, x: 5, y: 5, w: 20, h: 20 } },
    ], PAGES)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.fields.map((f) => f.name)).toEqual(['a', 'b'])
    expect(r.fields[1].bbox).toEqual({ page: 1, x: 5, y: 5, w: 20, h: 20 })
  })
})

// ──────────────────────────────────────────────────────────────────────────
// mergeFieldsSnapshot（グループB Phase B-1）
// ──────────────────────────────────────────────────────────────────────────

describe('mergeFieldsSnapshot 後方互換（UPDATE のみ＝G2-1 回帰なし）', () => {
  it('現行クライアント形式 {name,bbox}[] 全件を従来同様に bbox 差替・他属性温存', () => {
    const snapshot: FieldSnapshotItem[] = [
      { name: 'meeting_date', bbox: { page: 1, x: 120, y: 110, w: 90, h: 22 } },
      { name: 'topic', bbox: { page: 1, x: 100, y: 200, w: 300, h: 40 } },
    ]
    const r = mergeFieldsSnapshot(dbFields(), snapshot, PAGES)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const md = r.fields.find((f) => f.name === 'meeting_date')!
    expect(md.bbox).toEqual({ page: 1, x: 120, y: 110, w: 90, h: 22 })
    // label/font/padding/max_chars 温存（mergeBboxUpdates と同じ温存ポリシー）。
    expect(md.label).toBe('会議日')
    expect(md.max_chars).toBe(10)
    expect((md.font as { size: number }).size).toBe(11)
    expect(md.padding).toEqual({ left: 4, top: 4, right: 4, bottom: 4 })
    expect(r.fields.map((f) => f.name)).toEqual(['meeting_date', 'topic'])
  })

  it('label を送っても既存 field の label は温存（labelDirty 無しは差替しない）', () => {
    const snapshot: FieldSnapshotItem[] = [
      { name: 'meeting_date', label: '勝手な上書き', bbox: { page: 1, x: 100, y: 100, w: 80, h: 20 } },
      { name: 'topic', bbox: { page: 1, x: 100, y: 200, w: 300, h: 40 } },
    ]
    const r = mergeFieldsSnapshot(dbFields(), snapshot, PAGES)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.fields.find((f) => f.name === 'meeting_date')!.label).toBe('会議日')
  })
})

describe('mergeFieldsSnapshot DELETE', () => {
  it('スナップショットから外れた既存 field は除外される', () => {
    const snapshot: FieldSnapshotItem[] = [
      { name: 'meeting_date', bbox: { page: 1, x: 100, y: 100, w: 80, h: 20 } },
    ]
    const r = mergeFieldsSnapshot(dbFields(), snapshot, PAGES)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.fields.map((f) => f.name)).toEqual(['meeting_date'])
  })

  it('全部消すと FIELD_COUNT_OUT_OF_RANGE（最後の 1 枠ガード＝min1）', () => {
    const r = mergeFieldsSnapshot(dbFields(), [], PAGES)
    // 空配列は payload スキーマでも弾かれるが、merge 自体も件数 0 を拒否。
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('FIELD_COUNT_OUT_OF_RANGE')
  })
})

describe('mergeFieldsSnapshot INSERT（新規枠・属性デフォルト補完）', () => {
  it('isNew の新 field を末尾に追加し §2-4 デフォルトを補完', () => {
    const snapshot: FieldSnapshotItem[] = [
      { name: 'meeting_date', bbox: { page: 1, x: 100, y: 100, w: 80, h: 20 } },
      { name: 'topic', bbox: { page: 1, x: 100, y: 200, w: 300, h: 40 } },
      { name: 'field_3', label: '出席者', isNew: true, bbox: { page: 1, x: 50, y: 300, w: 200, h: 24 } },
    ]
    const r = mergeFieldsSnapshot(dbFields(), snapshot, PAGES)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.fields.map((f) => f.name)).toEqual(['meeting_date', 'topic', 'field_3'])
    const nf = r.fields[2]
    expect(nf.label).toBe('出席者')
    expect(nf.type).toBe('text')
    expect(nf.max_chars).toBe(NEW_FIELD_DEFAULTS.max_chars)
    expect(nf.padding).toEqual({ left: 4, top: 4, right: 4, bottom: 4 })
    // font は既存テンプレ最頻（NotoSansJP/11）を流用。
    expect(nf.font).toEqual({ family: 'NotoSansJP', size: 11 })
  })

  it('label 空の新 field は INVALID_LABEL', () => {
    const snapshot: FieldSnapshotItem[] = [
      { name: 'meeting_date', bbox: { page: 1, x: 100, y: 100, w: 80, h: 20 } },
      { name: 'topic', bbox: { page: 1, x: 100, y: 200, w: 300, h: 40 } },
      { name: 'field_3', label: '   ', isNew: true, bbox: { page: 1, x: 50, y: 300, w: 200, h: 24 } },
    ]
    const r = mergeFieldsSnapshot(dbFields(), snapshot, PAGES)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('INVALID_LABEL')
  })

  it('範囲外 bbox の新 field は BBOX_OUT_OF_RANGE', () => {
    const snapshot: FieldSnapshotItem[] = [
      { name: 'meeting_date', bbox: { page: 1, x: 100, y: 100, w: 80, h: 20 } },
      { name: 'topic', bbox: { page: 1, x: 100, y: 200, w: 300, h: 40 } },
      { name: 'field_3', label: 'x', isNew: true, bbox: { page: 1, x: 550, y: 300, w: 100, h: 24 } },
    ]
    const r = mergeFieldsSnapshot(dbFields(), snapshot, PAGES)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('BBOX_OUT_OF_RANGE')
  })
})

describe('mergeFieldsSnapshot 採番（衝突再採番）', () => {
  it('クライアント採番が既存 name と衝突したらサーバが空き field_N へ再採番', () => {
    // 新 field の name を既存 'topic' と衝突させる（isNew=true）。
    const snapshot: FieldSnapshotItem[] = [
      { name: 'meeting_date', bbox: { page: 1, x: 100, y: 100, w: 80, h: 20 } },
      { name: 'topic', bbox: { page: 1, x: 100, y: 200, w: 300, h: 40 } },
      { name: 'topic', label: '新規', isNew: true, bbox: { page: 1, x: 0, y: 400, w: 100, h: 24 } },
    ]
    const r = mergeFieldsSnapshot(dbFields(), snapshot, PAGES)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 既存 topic は維持、新規は再採番された別名。
    const names = r.fields.map((f) => f.name)
    expect(names.filter((n) => n === 'topic').length).toBe(1)
    expect(names[2]).toMatch(/^field_\d+$/)
    expect(names[2]).not.toBe('topic')
  })

  it('name 形式不正（大文字等）の新 field もサーバで field_N へ再採番', () => {
    const snapshot: FieldSnapshotItem[] = [
      { name: 'meeting_date', bbox: { page: 1, x: 100, y: 100, w: 80, h: 20 } },
      { name: 'topic', bbox: { page: 1, x: 100, y: 200, w: 300, h: 40 } },
      { name: 'BadName!!', label: '新規', isNew: true, bbox: { page: 1, x: 0, y: 400, w: 100, h: 24 } },
    ]
    const r = mergeFieldsSnapshot(dbFields(), snapshot, PAGES)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.fields[2].name).toMatch(/^field_\d+$/)
  })
})

describe('mergeFieldsSnapshot 分割（縦割り・labelDirty 左枠 label 差替 ＋ 右枠 INSERT）', () => {
  it('左枠=元 name 維持で label 差替・右枠=新規 field_N、font は元継承（最頻）', () => {
    // dbFields の topic（部署＋氏名 相当）を縦割り。左=topic(labelDirty), 右=新規。
    const snapshot: FieldSnapshotItem[] = [
      { name: 'meeting_date', bbox: { page: 1, x: 100, y: 100, w: 80, h: 20 } },
      { name: 'topic', label: '部署', labelDirty: true, bbox: { page: 1, x: 100, y: 200, w: 150, h: 40 } },
      { name: 'field_3', label: '氏名', isNew: true, bbox: { page: 1, x: 250, y: 200, w: 150, h: 40 } },
    ]
    const r = mergeFieldsSnapshot(dbFields(), snapshot, PAGES)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const left = r.fields.find((f) => f.name === 'topic')!
    expect(left.label).toBe('部署') // labelDirty で差替
    expect(left.bbox).toEqual({ page: 1, x: 100, y: 200, w: 150, h: 40 })
    const right = r.fields.find((f) => f.name === 'field_3')!
    expect(right.label).toBe('氏名')
    expect(right.bbox).toEqual({ page: 1, x: 250, y: 200, w: 150, h: 40 })
    expect(right.font).toEqual({ family: 'NotoSansJP', size: 11 })
  })

  it('labelDirty=true で label 空なら INVALID_LABEL（既存 label 差替の防御）', () => {
    const snapshot: FieldSnapshotItem[] = [
      { name: 'meeting_date', bbox: { page: 1, x: 100, y: 100, w: 80, h: 20 } },
      { name: 'topic', label: '', labelDirty: true, bbox: { page: 1, x: 100, y: 200, w: 150, h: 40 } },
    ]
    const r = mergeFieldsSnapshot(dbFields(), snapshot, PAGES)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('INVALID_LABEL')
  })
})

describe('mergeFieldsSnapshot 件数ガード', () => {
  it('反映後 21 件で FIELD_COUNT_OUT_OF_RANGE', () => {
    // 既存 2 件 + 新規 19 件 = 21 件。
    const snapshot: FieldSnapshotItem[] = [
      { name: 'meeting_date', bbox: { page: 1, x: 100, y: 100, w: 80, h: 20 } },
      { name: 'topic', bbox: { page: 1, x: 100, y: 200, w: 300, h: 40 } },
    ]
    for (let i = 0; i < 19; i++) {
      snapshot.push({
        name: `new_${i}`,
        label: `項目${i}`,
        isNew: true,
        bbox: { page: 1, x: 0, y: 10 + i, w: 50, h: 10 },
      })
    }
    // payload スキーマ（max20）は通さず merge 関数の件数判定を直接見るため 21 件で呼ぶ。
    const r = mergeFieldsSnapshot(dbFields(), snapshot, PAGES)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('FIELD_COUNT_OUT_OF_RANGE')
  })

  it('20 件ちょうどは OK', () => {
    const snapshot: FieldSnapshotItem[] = [
      { name: 'meeting_date', bbox: { page: 1, x: 100, y: 100, w: 80, h: 20 } },
      { name: 'topic', bbox: { page: 1, x: 100, y: 200, w: 300, h: 40 } },
    ]
    for (let i = 0; i < 18; i++) {
      snapshot.push({
        name: `new_${i}`,
        label: `項目${i}`,
        isNew: true,
        bbox: { page: 1, x: 0, y: 10 + i, w: 50, h: 10 },
      })
    }
    const r = mergeFieldsSnapshot(dbFields(), snapshot, PAGES)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.fields.length).toBe(20)
  })
})

describe('FieldsSnapshotPayloadSchema', () => {
  it('label/isNew/labelDirty は任意（{name,bbox} のみで通る＝後方互換）', () => {
    const ok = FieldsSnapshotPayloadSchema.safeParse([
      { name: 'a', bbox: { page: 1, x: 0, y: 0, w: 10, h: 10 } },
    ])
    expect(ok.success).toBe(true)
  })

  it('min1/max20 を payload でもガード', () => {
    expect(FieldsSnapshotPayloadSchema.safeParse([]).success).toBe(false)
    const many = Array.from({ length: 21 }, (_, i) => ({
      name: `f${i}`,
      bbox: { page: 1, x: 0, y: 0, w: 1, h: 1 },
    }))
    expect(FieldsSnapshotPayloadSchema.safeParse(many).success).toBe(false)
  })
})
