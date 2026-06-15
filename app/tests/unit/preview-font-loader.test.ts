/**
 * preview-font-loader unit test
 * （段階2-D3・設計書 v2.2 §1-2-6 推し案 B 推し根拠 4 / fallback 設計）。
 *
 * loadPreviewFont() の責務:
 *   - 成功時: opentype.js 経由で OTF を parse → FittableFont 互換オブジェクトを返す
 *   - 失敗時: 例外を throw せず null を返す（呼出側の fallback シグナル）
 *   - I/F 準拠: 返り値が widthOfTextAtSize / heightAtSize を持ち、FittableFont として fitting.ts に渡せる
 *
 * jsdom 環境では実 fetch / opentype.js dynamic import を動かさず、グローバル fetch と
 * opentype.js モジュール参照を spy / stub して経路を検証する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  loadPreviewFont,
  _resetPreviewFontCache,
} from '@/lib/parsers/pdf/preview-font-loader'

// opentype.js のモック（成功経路で使う）。
vi.mock('opentype.js', async () => {
  const fakeFont = {
    unitsPerEm: 1000,
    ascender: 880,
    descender: -120,
    getAdvanceWidth: (text: string, size: number) => text.length * size * 0.5,
  }
  return {
    parse: vi.fn(() => fakeFont),
    default: { parse: vi.fn(() => fakeFont) },
  }
})

const originalFetch = globalThis.fetch

beforeEach(() => {
  _resetPreviewFontCache()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  _resetPreviewFontCache()
  vi.restoreAllMocks()
})

describe('loadPreviewFont', () => {
  it('成功時に FittableFont 互換オブジェクトを返す（widthOfTextAtSize / heightAtSize）', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    })) as unknown as typeof fetch

    const font = await loadPreviewFont()
    expect(font).not.toBeNull()
    expect(typeof font!.widthOfTextAtSize).toBe('function')
    expect(typeof font!.heightAtSize).toBe('function')

    // getAdvanceWidth で代表文字幅取得（モック実装は length*size*0.5）
    const w = font!.widthOfTextAtSize('あいう', 14)
    expect(w).toBeCloseTo(3 * 14 * 0.5, 3)

    // heightAtSize = (ascent+descent)/unitsPerEm * size = (880+120)/1000 * 14 = 14
    const h = font!.heightAtSize(14)
    expect(h).toBeCloseTo(14, 3)
  })

  it('fetch 失敗（!ok）時は null を返す（throw しない）', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      arrayBuffer: async () => new ArrayBuffer(0),
    })) as unknown as typeof fetch

    const font = await loadPreviewFont()
    expect(font).toBeNull()
  })

  it('fetch reject 時は null（throw しない）', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch

    const font = await loadPreviewFont()
    expect(font).toBeNull()
  })

  it('同一セッション内で 2 回呼んでも fetch は 1 回（Promise 共有キャッシュ）', async () => {
    const spy = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    }))
    globalThis.fetch = spy as unknown as typeof fetch

    const [a, b] = await Promise.all([loadPreviewFont(), loadPreviewFont()])
    expect(a).not.toBeNull()
    expect(b).toBe(a)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('空文字や size<=0 では widthOfTextAtSize=0（防御）', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    })) as unknown as typeof fetch
    const font = await loadPreviewFont()
    expect(font!.widthOfTextAtSize('', 14)).toBe(0)
    expect(font!.widthOfTextAtSize('a', 0)).toBe(0)
  })
})
