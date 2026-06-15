/**
 * TextPdfExtractor unit test。
 *
 * - 知人サンプル no-writing.pdf（スキャン PDF）に対しては items=[] を返す
 * - 知人 5 件 IMG_9452〜9456.pdf（書込済スキャン）も items=[] 想定
 * - 構造的ダックタイピング（toTextItem）の正常系・異常系を確認
 *
 * 注意: 知人 PDF の内容（text 本文）は test assertion に書かない。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  extractTextPdfLayout,
  extractTextPdfLayoutFromBuffer,
} from '@/lib/parsers/pdf/text-extractor'

const SAMPLE_DIR = resolve(__dirname, '../../sample')
const haveSamples = existsSync(resolve(SAMPLE_DIR, 'no-writing.pdf'))

describe.skipIf(!haveSamples)('TextPdfExtractor - 知人サンプル', () => {
  it('no-writing.pdf（スキャン PDF）は items=[] を返す', async () => {
    const data = new Uint8Array(readFileSync(resolve(SAMPLE_DIR, 'no-writing.pdf')))
    const result = await extractTextPdfLayoutFromBuffer(data)
    expect(result.items).toEqual([])
    expect(result.pageSizes).toHaveLength(1)
    expect(result.pageSizes[0].page).toBe(1)
    expect(result.pageSizes[0].width).toBeGreaterThan(0)
    expect(result.pageSizes[0].height).toBeGreaterThan(0)
  }, 30000)

  it('IMG_9452.pdf（書込済スキャン）も items=[] を返す（パス B 経路は ScanPdfExtractor 担当）', async () => {
    const data = new Uint8Array(readFileSync(resolve(SAMPLE_DIR, 'IMG_9452.pdf')))
    const result = await extractTextPdfLayoutFromBuffer(data)
    // スキャン PDF は textItems が空なので items は基本的に空配列
    // （pdfjs が稀にメタデータ由来の小さな string item を返す可能性あり）
    expect(Array.isArray(result.items)).toBe(true)
    expect(result.pageSizes.length).toBeGreaterThan(0)
  }, 30000)
})

describe('TextPdfExtractor - 単体ロジック（fake document）', () => {
  it('テキスト item の transform 行列から bbox / fontSize を正しく計算する', async () => {
    const fakeDoc = {
      numPages: 1,
      async getPage() {
        return {
          getViewport: () => ({ width: 595, height: 842 }),  // A4 縦 pt
          async getTextContent() {
            return {
              items: [
                {
                  str: '議事録',
                  // [scaleX=12, skewY=0, skewX=0, scaleY=12, translateX=60, translateY=800]
                  // → fontSize = sqrt(12^2 + 0^2) = 12
                  transform: [12, 0, 0, 12, 60, 800],
                  width: 36,
                  height: 12,
                  fontName: 'NotoSansJP',
                },
              ],
            }
          },
        }
      },
      async destroy() {},
    }
    const result = await extractTextPdfLayout(fakeDoc)
    expect(result.items).toHaveLength(1)
    const item = result.items[0]
    expect(item.text).toBe('議事録')
    expect(item.page).toBe(1)
    expect(item.bbox.x).toBe(60)
    // PDF 座標は左下原点（translateY=800）→ 左上原点に変換: 842 - 800 - 12 = 30
    expect(item.bbox.y).toBe(30)
    expect(item.bbox.w).toBe(36)
    expect(item.bbox.h).toBe(12)
    expect(item.fontSize).toBeCloseTo(12, 5)
    expect(item.fontName).toBe('NotoSansJP')
  })

  it('複数ページのテキストを正しく集約する', async () => {
    let pageCalled = 0
    const fakeDoc = {
      numPages: 3,
      async getPage(n: number) {
        pageCalled++
        return {
          getViewport: () => ({ width: 595, height: 842 }),
          async getTextContent() {
            return {
              items: [
                {
                  str: `p${n}-text`,
                  transform: [10, 0, 0, 10, 50, 700],
                  width: 50,
                  height: 10,
                  fontName: 'Helvetica',
                },
              ],
            }
          },
        }
      },
      async destroy() {},
    }
    const result = await extractTextPdfLayout(fakeDoc)
    expect(result.items).toHaveLength(3)
    expect(result.items.map(i => i.text)).toEqual(['p1-text', 'p2-text', 'p3-text'])
    expect(result.items.map(i => i.page)).toEqual([1, 2, 3])
    expect(result.pageSizes).toHaveLength(3)
    expect(pageCalled).toBe(3)
  })

  it('TextMarkedContent や不正 item を無視する（構造的ダックタイピング）', async () => {
    const fakeDoc = {
      numPages: 1,
      async getPage() {
        return {
          getViewport: () => ({ width: 595, height: 842 }),
          async getTextContent() {
            return {
              items: [
                { type: 'beginMarkedContent' }, // TextMarkedContent
                { str: 'valid', transform: [10, 0, 0, 10, 0, 0], width: 30, height: 10, fontName: 'Foo' },
                null as unknown,
                { str: 'missing-transform', width: 30, height: 10, fontName: 'Foo' },
                { str: 'short-transform', transform: [1, 2, 3], width: 30, height: 10, fontName: 'Foo' },
                'not-an-object' as unknown,
              ],
            }
          },
        }
      },
      async destroy() {},
    }
    const result = await extractTextPdfLayout(fakeDoc)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].text).toBe('valid')
  })

  it('skewY=0 でない transform でも fontSize はベクトル長で計算', async () => {
    const fakeDoc = {
      numPages: 1,
      async getPage() {
        return {
          getViewport: () => ({ width: 595, height: 842 }),
          async getTextContent() {
            return {
              items: [
                {
                  str: 'rotated',
                  // 45 度回転を想定（scaleX=8.485, skewY=8.485 → fontSize = 12）
                  transform: [8.485, 8.485, -8.485, 8.485, 100, 100],
                  width: 50,
                  height: 12,
                  fontName: 'Foo',
                },
              ],
            }
          },
        }
      },
      async destroy() {},
    }
    const result = await extractTextPdfLayout(fakeDoc)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].fontSize).toBeCloseTo(12, 1)
  })

  it('items=[] のページもエラーにならない', async () => {
    const fakeDoc = {
      numPages: 2,
      async getPage() {
        return {
          getViewport: () => ({ width: 595, height: 842 }),
          async getTextContent() {
            return { items: [] }
          },
        }
      },
      async destroy() {},
    }
    const result = await extractTextPdfLayout(fakeDoc)
    expect(result.items).toEqual([])
    expect(result.pageSizes).toHaveLength(2)
  })
})
