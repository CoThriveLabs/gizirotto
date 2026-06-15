/**
 * 段階2-D3 案 D（v2.5 §1-2-6-2）: render-image API の overlayFields 選別純関数の unit。
 *
 * 3 ケース回帰:
 *   - (1) raw=false → 全 field 積む（既存挙動）
 *   - (2) raw=true, raw_except_selected=undefined → 全 field skip（既存挙動）
 *   - (3) raw=true, raw_except_selected='memo' → memo のみ skip・他は積む（v2.5 新規）
 *
 * + キャッシュキー接尾辞 buildRawCacheSuffix の 3 分岐（'' / '_raw' / '_raw_except_*'）。
 */
import { describe, it, expect } from 'vitest'
import {
  buildOverlayFieldsForRender,
  buildRawCacheSuffix,
} from '@/lib/pdf-output/render-image-overlay-filter'

type TestField = { name: string }

const fields: TestField[] = [
  { name: 'title' },
  { name: 'memo' },
  { name: 'date' },
]
const values: Record<string, string> = {
  title: 'Mtg',
  memo: 'これは編集中の文章',
  date: '2026-06-08',
}

describe('buildOverlayFieldsForRender', () => {
  it('raw=false: 全 field を overlay に積む（既存挙動・後方互換）', () => {
    const out = buildOverlayFieldsForRender(fields, values, false, undefined)
    expect(out).toHaveLength(3)
    expect(out.map((e) => e.field.name)).toEqual(['title', 'memo', 'date'])
    expect(out.map((e) => e.value)).toEqual(['Mtg', 'これは編集中の文章', '2026-06-08'])
  })

  it('raw=true (raw_except_selected 未指定): 全 field skip（既存挙動・既存 raw 経路）', () => {
    const out = buildOverlayFieldsForRender(fields, values, true, undefined)
    expect(out).toHaveLength(0)
  })

  it('raw=true, raw_except_selected="memo": memo のみ skip・他は積む（v2.5 案 D 新規）', () => {
    const out = buildOverlayFieldsForRender(fields, values, true, 'memo')
    expect(out).toHaveLength(2)
    expect(out.map((e) => e.field.name)).toEqual(['title', 'date'])
    // 選択中の memo は overlay に出ない = canvas 動的合成側に任せる
    expect(out.find((e) => e.field.name === 'memo')).toBeUndefined()
  })

  it('raw=true, raw_except_selected が存在しない name: 全 field skip と同等（防御）', () => {
    // 'no-such-field' は fields に無いので、結果として全 field がループに入って value 確認・積まれる…
    // ではなく、raw=true で rawExceptSelected !== undefined のときは loop に入る = no-such-field 以外
    // 全部積む。これは「未知 selected を投げても落ちない」防御。
    const out = buildOverlayFieldsForRender(fields, values, true, 'no-such-field')
    expect(out).toHaveLength(3) // 全 field が積まれる
  })

  it('raw=false 時に空文字 / null 値は積まれない（既存挙動の維持）', () => {
    const partialValues: Record<string, unknown> = {
      title: 'Mtg',
      memo: '',
      date: null,
    }
    const out = buildOverlayFieldsForRender(fields, partialValues, false, undefined)
    expect(out).toHaveLength(1)
    expect(out[0]?.field.name).toBe('title')
  })

  it('raw=true + 案 D: skip 対象 field は値が空でも overlay には出ない（早期 continue）', () => {
    const partialValues: Record<string, unknown> = {
      title: 'Mtg',
      memo: '',
      date: '2026-06-08',
    }
    const out = buildOverlayFieldsForRender(fields, partialValues, true, 'memo')
    expect(out.map((e) => e.field.name)).toEqual(['title', 'date'])
  })
})

describe('buildRawCacheSuffix', () => {
  it('raw=false: 空文字（既存通常キャッシュキーと混ざらない）', () => {
    expect(buildRawCacheSuffix(false, undefined)).toBe('')
    // raw=false 時に raw_except_selected が指定されても影響なし（仕様: raw=true 時のみ作用）
    expect(buildRawCacheSuffix(false, 'memo')).toBe('')
  })

  it('raw=true, raw_except_selected 未指定: "_raw"（既存全 skip 経路の接尾）', () => {
    expect(buildRawCacheSuffix(true, undefined)).toBe('_raw')
  })

  it('raw=true, raw_except_selected="memo": "_raw_except_memo"（v2.5 案 D・per-field）', () => {
    expect(buildRawCacheSuffix(true, 'memo')).toBe('_raw_except_memo')
  })

  it('field name に path traversal 文字が混入しても sanitize される（防御）', () => {
    expect(buildRawCacheSuffix(true, '../etc/passwd')).toBe('_raw_except____etc_passwd')
    expect(buildRawCacheSuffix(true, 'field/with/slash')).toBe('_raw_except_field_with_slash')
  })

  it('英数 + _ + - はそのまま保たれる（衝突しない）', () => {
    expect(buildRawCacheSuffix(true, 'field-1_a')).toBe('_raw_except_field-1_a')
  })
})
