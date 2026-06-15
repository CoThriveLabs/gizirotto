import { describe, it, expect } from 'vitest'
import {
  loadBuiltinBackgroundPng,
  loadBuiltinThumbnailPng,
} from '@/lib/builtin-bbox-loader'

/**
 * 背景用 PNG（`{slug}.bg.png`）配信ヘルパの unit test。
 *
 * 観点:
 *   1) 3 件の builtin slug 全てで背景 PNG が読み込めること
 *   2) 背景 PNG のサイズはサムネ PNG より明確に小さいこと（値セルが空白＝
 *      文字描画がほぼ無いため PNG 圧縮が効く・ダミー値焼き込みゼロの間接検証）
 *   3) 許可リスト外 slug は null
 *   4) PNG マジックバイト（0x89 0x50 0x4E 0x47）で正しい PNG であること
 */

describe('loadBuiltinBackgroundPng', () => {
  const slugs = ['family-meeting', 'child-schedule', 'budget-report'] as const

  it('3 件すべての builtin slug で背景 PNG を読み込める', async () => {
    for (const slug of slugs) {
      const bg = await loadBuiltinBackgroundPng(slug)
      expect(bg, `slug=${slug}`).not.toBeNull()
      expect(bg!.length).toBeGreaterThan(0)
    }
  })

  it('背景 PNG はサムネ PNG より小さい（ダミー値焼き込みゼロの間接検証）', async () => {
    for (const slug of slugs) {
      const bg = await loadBuiltinBackgroundPng(slug)
      const thumb = await loadBuiltinThumbnailPng(slug)
      expect(bg, `bg slug=${slug}`).not.toBeNull()
      expect(thumb, `thumb slug=${slug}`).not.toBeNull()
      // 値セルが空白で文字描画が無いぶん圧縮率が上がるため bg < thumb を期待。
      // 仮にダミー値が混入したら bg のバイト数がサムネに近づき、本 assertion で気付ける。
      expect(bg!.length, `bg<thumb slug=${slug}`).toBeLessThan(thumb!.length)
    }
  })

  it('PNG マジックバイトで正しい PNG ファイルであること', async () => {
    for (const slug of slugs) {
      const bg = await loadBuiltinBackgroundPng(slug)
      expect(bg, `slug=${slug}`).not.toBeNull()
      const head = bg!.slice(0, 4)
      expect(Array.from(head)).toEqual([0x89, 0x50, 0x4e, 0x47])
    }
  })

  it('許可リスト外 slug は null を返す', async () => {
    expect(await loadBuiltinBackgroundPng('other-slug')).toBeNull()
    expect(await loadBuiltinBackgroundPng('')).toBeNull()
  })
})
