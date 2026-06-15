import { describe, it, expect } from 'vitest'
import {
  whiteoutBoxesToFields,
  fieldsToWhiteoutBoxes,
  whiteoutFieldName,
  type WhiteoutBoxInput,
} from '@/lib/pdf-output/whiteout-adapter'
import type { WhiteoutBox } from '@/lib/parsers/pdf/whiteout-pipeline'

// WhiteoutBox ⇔ EditorField アダプタの担保。
// 核心＝座標無変換の往復一致（±0・丸めなし）と source/estimatedBgColor/dismissed の保存。
// 却下(dismissed)ボックスは保存（焼き込み）対象から除外されること（個人情報保護）。

const WHITE = { r: 255, g: 255, b: 255 }
const GRAY = { r: 200, g: 200, b: 200 }

function box(
  page: number,
  x: number,
  y: number,
  w: number,
  h: number,
  source: 'auto_suggestion' | 'manual',
  bg = WHITE,
): WhiteoutBox {
  return { page, bbox: { x, y, w, h }, estimatedBgColor: bg, source }
}

describe('whiteoutFieldName（合成 name 採番）', () => {
  it('index 0始まり → wo_N（1始まり・field_N と非衝突の接頭辞）', () => {
    expect(whiteoutFieldName(0)).toBe('wo_1')
    expect(whiteoutFieldName(1)).toBe('wo_2')
    expect(whiteoutFieldName(9)).toBe('wo_10')
  })
})

describe('whiteoutBoxesToFields → fieldsToWhiteoutBoxes（往復一致）', () => {
  it('複数ボックスが座標・source・estimatedBgColor を保ったまま往復一致する', () => {
    const boxes: WhiteoutBox[] = [
      box(1, 10, 20, 100, 24, 'auto_suggestion', WHITE),
      box(1, 50.5, 60.25, 200.75, 30.125, 'manual', GRAY),
      box(2, 0, 0, 595, 12, 'auto_suggestion', WHITE),
    ]
    const { fields, meta } = whiteoutBoxesToFields(boxes)
    const roundtrip = fieldsToWhiteoutBoxes(fields, meta)
    expect(roundtrip).toEqual(boxes)
  })

  it('座標は無変換（丸めなし）で小数も完全一致', () => {
    const boxes = [box(1, 1.111, 2.222, 3.333, 4.444, 'manual')]
    const { fields, meta } = whiteoutBoxesToFields(boxes)
    expect(fields[0].bbox).toEqual({
      x: 1.111,
      y: 2.222,
      w: 3.333,
      h: 4.444,
      page: 1,
    })
    const back = fieldsToWhiteoutBoxes(fields, meta)
    expect(back[0].bbox).toEqual({ x: 1.111, y: 2.222, w: 3.333, h: 4.444 })
  })

  it('fields は label 空・name は wo_N 採番（命名パネル非表示）', () => {
    const { fields } = whiteoutBoxesToFields([
      box(1, 0, 0, 10, 10, 'manual'),
      box(1, 0, 0, 10, 10, 'auto_suggestion'),
    ])
    expect(fields.map((f) => f.name)).toEqual(['wo_1', 'wo_2'])
    expect(fields.every((f) => f.label === '')).toBe(true)
  })
})

describe('空配列', () => {
  it('whiteoutBoxesToFields([]) は空 fields・空 meta', () => {
    const { fields, meta } = whiteoutBoxesToFields([])
    expect(fields).toEqual([])
    expect(meta.size).toBe(0)
  })
  it('fieldsToWhiteoutBoxes([], empty) は []', () => {
    expect(fieldsToWhiteoutBoxes([], new Map())).toEqual([])
  })
})

describe('auto / manual 混在', () => {
  it('source が field 順に meta で保持され往復で復元される', () => {
    const boxes: WhiteoutBox[] = [
      box(1, 0, 0, 10, 10, 'auto_suggestion'),
      box(1, 20, 20, 10, 10, 'manual'),
      box(1, 40, 40, 10, 10, 'auto_suggestion'),
    ]
    const { fields, meta } = whiteoutBoxesToFields(boxes)
    expect(meta.get('wo_1')?.source).toBe('auto_suggestion')
    expect(meta.get('wo_2')?.source).toBe('manual')
    expect(meta.get('wo_3')?.source).toBe('auto_suggestion')
    expect(fieldsToWhiteoutBoxes(fields, meta).map((b) => b.source)).toEqual([
      'auto_suggestion',
      'manual',
      'auto_suggestion',
    ])
  })
})

describe('dismissed あり（却下＝焼き込み対象外）', () => {
  it('取り込み時 dismissed を meta に保持する', () => {
    const boxes: WhiteoutBoxInput[] = [
      { ...box(1, 0, 0, 10, 10, 'auto_suggestion'), dismissed: true },
      box(1, 20, 20, 10, 10, 'manual'),
    ]
    const { meta } = whiteoutBoxesToFields(boxes)
    expect(meta.get('wo_1')?.dismissed).toBe(true)
    expect(meta.get('wo_2')?.dismissed).toBeUndefined()
  })

  it('保存（fieldsToWhiteoutBoxes）は dismissed を除外する', () => {
    const boxes: WhiteoutBoxInput[] = [
      { ...box(1, 0, 0, 10, 10, 'auto_suggestion'), dismissed: true },
      box(1, 20, 20, 10, 10, 'manual'),
    ]
    const { fields, meta } = whiteoutBoxesToFields(boxes)
    const out = fieldsToWhiteoutBoxes(fields, meta)
    // 却下分は落ち、採用分（manual）のみが残る。
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual(box(1, 20, 20, 10, 10, 'manual'))
  })

  it('編集中に却下トグルされた meta も除外される（採用→却下）', () => {
    const boxes = [
      box(1, 0, 0, 10, 10, 'auto_suggestion'),
      box(1, 20, 20, 10, 10, 'manual'),
    ]
    const { fields, meta } = whiteoutBoxesToFields(boxes)
    // wo_1 を編集セッション内で却下に変更。
    meta.set('wo_1', { ...meta.get('wo_1')!, dismissed: true })
    const out = fieldsToWhiteoutBoxes(fields, meta)
    expect(out).toHaveLength(1)
    expect(out[0].source).toBe('manual')
  })
})

describe('meta 欠落（新規ドラッグ追加の異常時）の安全側補完', () => {
  it('meta に無い field は manual / 不透明白で補完される', () => {
    const fields = [
      { name: 'wo_1', label: '', bbox: { x: 5, y: 5, w: 50, h: 12, page: 1 } },
    ]
    const out = fieldsToWhiteoutBoxes(fields, new Map())
    expect(out[0]).toEqual({
      page: 1,
      bbox: { x: 5, y: 5, w: 50, h: 12 },
      estimatedBgColor: { r: 255, g: 255, b: 255 },
      source: 'manual',
    })
  })
})
