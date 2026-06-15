/**
 * `parseBuiltinPagePtSize` / `loadBuiltinPagePtSize` の unit test。
 *
 * 役割:
 *   bg.png + overlay 合成（renderMinuteBuiltinBgWithOverlayToImages）の sx/sy 変換係数を
 *   算出するため、builtin bbox JSON から `page.{width,height}` を pt 単位で取り出す純関数。
 *
 * テスト方針:
 *   1) 正常 JSON から width/height を取り出せる
 *   2) page セクション欠落 / 数値以外 / 負値 / NaN は null を返し throw しない
 *   3) loadBuiltinPagePtSize は許可リスト外 slug を null で弾く
 *   4) 実 fs：family-meeting.bbox.json から 595×842 が取り出せる
 */
import { describe, it, expect } from 'vitest'
import {
  parseBuiltinPagePtSize,
  loadBuiltinPagePtSize,
} from '@/lib/builtin-bbox-loader'

describe('parseBuiltinPagePtSize', () => {
  it('正常な JSON から page.width / height を取り出せる', () => {
    const raw = {
      slug: 'family-meeting',
      page: { width: 595, height: 842 },
      fields: {},
    }
    expect(parseBuiltinPagePtSize(raw)).toEqual({ width: 595, height: 842 })
  })

  it('page キー欠落 → null', () => {
    expect(parseBuiltinPagePtSize({ slug: 'x' })).toBeNull()
  })

  it('page が object でない → null', () => {
    expect(parseBuiltinPagePtSize({ page: 'invalid' })).toBeNull()
  })

  it('width / height が数値でない → null', () => {
    expect(parseBuiltinPagePtSize({ page: { width: 'a', height: 842 } })).toBeNull()
    expect(parseBuiltinPagePtSize({ page: { width: 595, height: null } })).toBeNull()
  })

  it('width / height が 0 or 負値 → null（座標誤焼き込み回避）', () => {
    expect(parseBuiltinPagePtSize({ page: { width: 0, height: 842 } })).toBeNull()
    expect(parseBuiltinPagePtSize({ page: { width: 595, height: -10 } })).toBeNull()
  })

  it('NaN / Infinity → null', () => {
    expect(parseBuiltinPagePtSize({ page: { width: NaN, height: 842 } })).toBeNull()
    expect(
      parseBuiltinPagePtSize({ page: { width: Infinity, height: 842 } }),
    ).toBeNull()
  })

  it('raw 自体が null / undefined / 非 object でも throw しない', () => {
    expect(parseBuiltinPagePtSize(null)).toBeNull()
    expect(parseBuiltinPagePtSize(undefined)).toBeNull()
    expect(parseBuiltinPagePtSize('foo')).toBeNull()
    expect(parseBuiltinPagePtSize(42)).toBeNull()
  })
})

describe('loadBuiltinPagePtSize (実 fs)', () => {
  it('family-meeting slug で 595×842 (A4 縦 pt) を取り出せる', async () => {
    const out = await loadBuiltinPagePtSize('family-meeting')
    expect(out).toEqual({ width: 595, height: 842 })
  })

  it('child-schedule slug で page サイズが取れる', async () => {
    const out = await loadBuiltinPagePtSize('child-schedule')
    expect(out).not.toBeNull()
    expect(out!.width).toBeGreaterThan(0)
    expect(out!.height).toBeGreaterThan(0)
  })

  it('許可リスト外 slug は null（誤適用防止）', async () => {
    const out = await loadBuiltinPagePtSize('non-existent-slug')
    expect(out).toBeNull()
  })
})
