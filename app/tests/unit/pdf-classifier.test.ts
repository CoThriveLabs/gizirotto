/**
 * PdfClassifier unit test。
 *
 * 知人サンプル 5 件（IMG_9452〜9456.pdf）+ no-writing.pdf に対して
 * 'text' / 'scan' 判定が安定動作することを確認する。
 *
 * 注意: 知人 PDF の内容情報（テキスト本文）は assertion に書かない。
 * pageCount / totalCharCount / pdfType の数値メタのみを扱う。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { classifyPdfBuffer } from '@/lib/parsers/pdf/classifier'

const SAMPLE_DIR = resolve(__dirname, '../../sample')

interface SampleCase {
  name: string
  file: string
}

const SAMPLES: SampleCase[] = [
  { name: 'no-writing (未書込原本、パス A 検証用)', file: 'no-writing.pdf' },
  { name: 'IMG_9452 (書込済、パス B 検証用)', file: 'IMG_9452.pdf' },
  { name: 'IMG_9453', file: 'IMG_9453.pdf' },
  { name: 'IMG_9454', file: 'IMG_9454.pdf' },
  { name: 'IMG_9455', file: 'IMG_9455.pdf' },
  { name: 'IMG_9456', file: 'IMG_9456.pdf' },
]

const haveSamples = existsSync(resolve(SAMPLE_DIR, 'no-writing.pdf'))

describe.skipIf(!haveSamples)('PdfClassifier - 知人サンプル 6 件', () => {
  for (const sample of SAMPLES) {
    it(`${sample.name} は text または scan に分類できる`, async () => {
      const data = new Uint8Array(readFileSync(resolve(SAMPLE_DIR, sample.file)))
      const result = await classifyPdfBuffer(data)
      expect(['text', 'scan']).toContain(result.pdfType)
      expect(result.pageCount).toBeGreaterThan(0)
      expect(result.totalCharCount).toBeGreaterThanOrEqual(0)
    }, 20000)
  }

  it('no-writing.pdf は scan 判定（事前期待）', async () => {
    const data = new Uint8Array(readFileSync(resolve(SAMPLE_DIR, 'no-writing.pdf')))
    const result = await classifyPdfBuffer(data)
    expect(result.pdfType).toBe('scan')
    expect(result.pageCount).toBe(1)
  }, 20000)
})

describe('PdfClassifier - 閾値ロジック単体', () => {
  it('合計 50 文字以下の文字数は scan 判定', async () => {
    const { classifyPdfDocument } = await import('@/lib/parsers/pdf/classifier')
    const fakeDoc = {
      numPages: 1,
      async getPage() {
        return {
          async getTextContent() {
            return { items: [{ str: 'abcde' }] }
          },
        }
      },
    }
    const r = await classifyPdfDocument(fakeDoc)
    expect(r.pdfType).toBe('scan')
    expect(r.totalCharCount).toBe(5)
  })

  it('合計 51 文字以上の文字数は text 判定', async () => {
    const { classifyPdfDocument } = await import('@/lib/parsers/pdf/classifier')
    const longStr = 'a'.repeat(60)
    const fakeDoc = {
      numPages: 1,
      async getPage() {
        return {
          async getTextContent() {
            return { items: [{ str: longStr }] }
          },
        }
      },
    }
    const r = await classifyPdfDocument(fakeDoc)
    expect(r.pdfType).toBe('text')
    expect(r.totalCharCount).toBe(60)
  })

  it('複数ページ・複数 item にまたがる合計をカウント', async () => {
    const { classifyPdfDocument } = await import('@/lib/parsers/pdf/classifier')
    const fakeDoc = {
      numPages: 2,
      async getPage() {
        return {
          async getTextContent() {
            return {
              items: [{ str: 'a'.repeat(30) }, { str: 'b'.repeat(30) }],
            }
          },
        }
      },
    }
    const r = await classifyPdfDocument(fakeDoc)
    expect(r.totalCharCount).toBe(120)
    expect(r.pageCount).toBe(2)
    expect(r.pdfType).toBe('text')
  })

  it('閾値オプションで挙動を変更できる', async () => {
    const { classifyPdfDocument } = await import('@/lib/parsers/pdf/classifier')
    const fakeDoc = {
      numPages: 1,
      async getPage() {
        return {
          async getTextContent() {
            return { items: [{ str: 'a'.repeat(10) }] }
          },
        }
      },
    }
    const lax = await classifyPdfDocument(fakeDoc, { textThreshold: 5 })
    expect(lax.pdfType).toBe('text')
    const strict = await classifyPdfDocument(fakeDoc, { textThreshold: 100 })
    expect(strict.pdfType).toBe('scan')
  })

  it('items に str 以外の混入があっても無視する', async () => {
    const { classifyPdfDocument } = await import('@/lib/parsers/pdf/classifier')
    const fakeDoc = {
      numPages: 1,
      async getPage() {
        return {
          async getTextContent() {
            return {
              items: [
                { str: 'hello' },
                { transform: [1, 0, 0, 1, 0, 0] },
                null as unknown,
                'not-an-object' as unknown,
              ],
            }
          },
        }
      },
    }
    const r = await classifyPdfDocument(fakeDoc)
    expect(r.totalCharCount).toBe(5)
  })
})
