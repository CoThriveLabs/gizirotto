/**
 * ScanPdfExtractor integration test。
 *
 * 実 Mistral OCR API + Tesseract.js + @napi-rs/canvas + pdfjs-serverless 経由で
 * 知人サンプル PDF 6 件（パス A 検証用 no-writing.pdf + パス B 検証用
 * IMG_9452〜9456.pdf）に対しハイブリッドパイプラインを動作確認する。
 *
 * 動作要件:
 *   - MISTRAL_API_KEY が .env.local に設定されていること
 *   - app/sample/*.pdf が存在すること（git 管理外、開発者ローカルのみ）
 *
 * 実行:
 *   pnpm test:integration scan-extractor
 *
 * 課金: 6 件 × 約 $0.002 / 件 = 約 $0.012（Mistral OCR realtime）
 *
 * CI 除外（vitest.integration.config.ts は CI に含めない既定）。
 *
 * 知人 PDF 由来内容（テキスト本文 / fields の name / label 以外）は
 * test assertion / console log のいずれにも書かない。
 * structural な assertion のみ:
 *     - 要素数下限
 *     - 型 (printed_text / handwriting / table_cell / source 分布)
 *     - bbox 範囲妥当性（ページ内に収まるか）
 *     - confidence 範囲 (0..1)
 *     - markdown 長さ下限
 *   ログ出力は **件数のみ**（テキスト本文は出力しない）
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'
import {
  extractScanPdfLayout,
  type ScanOcrResult,
} from '@/lib/parsers/pdf/scan-extractor'

loadEnv({ path: resolve(__dirname, '../../.env.local') })

const SAMPLE_DIR = resolve(__dirname, '../../sample')

interface SampleFixture {
  /** display 名（log 用、PDF 内容は含まない） */
  name: string
  /** ファイル名 */
  file: string
  /** 検証パス（A = 未書込原本 / B = 書込済 → 白塗り） */
  pathType: 'A' | 'B'
}

const SAMPLES: SampleFixture[] = [
  { name: 'no-writing (パス A 未書込原本)', file: 'no-writing.pdf', pathType: 'A' },
  { name: 'IMG_9452 (パス B 書込済 #1)', file: 'IMG_9452.pdf', pathType: 'B' },
  { name: 'IMG_9453 (パス B 書込済 #2)', file: 'IMG_9453.pdf', pathType: 'B' },
  { name: 'IMG_9454 (パス B 書込済 #3)', file: 'IMG_9454.pdf', pathType: 'B' },
  { name: 'IMG_9455 (パス B 書込済 #4)', file: 'IMG_9455.pdf', pathType: 'B' },
  { name: 'IMG_9456 (パス B 書込済 #5)', file: 'IMG_9456.pdf', pathType: 'B' },
]

const haveAllSamples = SAMPLES.every(s => existsSync(resolve(SAMPLE_DIR, s.file)))
const haveApiKey = !!process.env.MISTRAL_API_KEY

/**
 * 1 ScanOcrResult に対する共通 structural assertion。
 * 知人 PDF 内容に依存しない、純粋な構造チェックのみ。
 */
function assertScanResultStructure(result: ScanOcrResult): {
  pages: number
  elements: number
  tableCells: number
  both: number
  tesseractOnly: number
  markdownLen: number
} {
  expect(result).toBeDefined()
  expect(Array.isArray(result.pages)).toBe(true)
  expect(result.pages.length).toBeGreaterThanOrEqual(1)

  let totalElements = 0
  let totalTableCells = 0
  let totalBoth = 0
  let totalTesseractOnly = 0
  let totalMarkdownLen = 0

  for (const page of result.pages) {
    expect(typeof page.pageIndex).toBe('number')
    expect(page.pageIndex).toBeGreaterThanOrEqual(0)
    expect(page.pageSize.widthPt).toBeGreaterThan(0)
    expect(page.pageSize.heightPt).toBeGreaterThan(0)
    expect(typeof page.sourceMarkdown).toBe('string')
    expect(Array.isArray(page.elements)).toBe(true)
    totalMarkdownLen += page.sourceMarkdown.length

    for (const el of page.elements) {
      totalElements++
      expect(['printed_text', 'handwriting', 'table_cell']).toContain(el.type)
      expect(['mistral+tesseract', 'tesseract_only']).toContain(el.source)
      expect(typeof el.text).toBe('string')
      expect(el.bbox.x).toBeGreaterThanOrEqual(0)
      expect(el.bbox.y).toBeGreaterThanOrEqual(0)
      expect(el.bbox.w).toBeGreaterThan(0)
      expect(el.bbox.h).toBeGreaterThan(0)
      // bbox はページ範囲内（多少のマージン許容、回転 / アンチエイリアス余裕）
      expect(el.bbox.x + el.bbox.w).toBeLessThanOrEqual(page.pageSize.widthPt + 10)
      expect(el.bbox.y + el.bbox.h).toBeLessThanOrEqual(page.pageSize.heightPt + 10)
      expect(el.confidence).toBeGreaterThanOrEqual(0)
      expect(el.confidence).toBeLessThanOrEqual(1)
      if (el.type === 'table_cell') {
        totalTableCells++
        expect(typeof el.tableHtml).toBe('string')
        expect(el.tableHtml!.length).toBeGreaterThan(0)
      }
      if (el.source === 'mistral+tesseract') totalBoth++
      else totalTesseractOnly++
    }
  }

  return {
    pages: result.pages.length,
    elements: totalElements,
    tableCells: totalTableCells,
    both: totalBoth,
    tesseractOnly: totalTesseractOnly,
    markdownLen: totalMarkdownLen,
  }
}

describe.skipIf(!haveAllSamples || !haveApiKey)(
  'ScanPdfExtractor integration - 知人サンプル 6 件',
  () => {
    for (const sample of SAMPLES) {
      // 知人 PDF 内容に依存しない structural assertion のみ
      it(
        `${sample.name}: hybrid pipeline 完走 + 構造的整合性 OK`,
        async () => {
          const data = new Uint8Array(readFileSync(resolve(SAMPLE_DIR, sample.file)))
          const result = await extractScanPdfLayout(data)
          const stats = assertScanResultStructure(result)

          // 議事録テンプレ用途の最低限の要件:
          //   - 1 ページ以上
          //   - elements が 1 個以上取れる（OCR が完全失敗していない）
          //   - markdown が一定長さ以上（Mistral OCR が応答している）
          expect(stats.pages).toBeGreaterThanOrEqual(1)
          expect(stats.elements).toBeGreaterThan(0)
          expect(stats.markdownLen).toBeGreaterThan(10)

          // ログ出力（件数のみ、テキスト本文は絶対に出力しない）
          // eslint-disable-next-line no-console
          console.log(
            `[integration:${sample.pathType}] file=${sample.file} pages=${stats.pages} elements=${stats.elements} table_cells=${stats.tableCells} merge=${stats.both} tesseract_only=${stats.tesseractOnly} markdown_chars=${stats.markdownLen}`,
          )
        },
        180_000, // Mistral OCR + Tesseract.js（複数ページの可能性あり）で余裕を持って 180 秒
      )
    }
  },
)
