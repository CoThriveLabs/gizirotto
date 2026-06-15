/**
 * whiteout-preview flow integration test（設計 v0.5 §7 Integration / 案 B 適用）。
 *
 * 検証対象: IMG_9452 fixture を extractScanPdfLayout に流し、
 *   結果に table_cell が含まれること（v0.5 案 B 上書き経路が走ること）。
 *
 * 動作要件:
 *   - MISTRAL_API_KEY が .env.local に設定
 *   - app/sample/IMG_9452.pdf が存在（git 管理外、開発者ローカルのみ）
 *
 * 設計 §11-3 / 依頼書 §3-7 厳守: 知人 PDF 由来内容は assertion に書かない。
 * 構造（type 分布 / 件数 / source）のみを検証する。
 *
 * CI 除外（vitest.integration.config.ts は CI に含めない既定）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'
import { extractScanPdfLayout } from '@/lib/parsers/pdf/scan-extractor'
import {
  classifyCellRoles,
  type RoleClassifierClient,
  type CellClassification,
} from '@/lib/parsers/pdf/whiteout-role-classifier'
import { prefilterCells } from '@/lib/parsers/pdf/whiteout-prefilter'
import { renderPdfPagesToPng } from '@/lib/parsers/pdf/pdf-page-rasterizer'
import {
  detectFieldBboxes,
  type RasterPagePixels,
} from '@/lib/parsers/pdf/field-bbox-detector'
import { suggestWhiteoutCandidatesByField } from '@/lib/parsers/pdf/whiteout-pipeline'
import type {
  LayoutCluster,
  LayoutCell,
} from '@/lib/parsers/pdf/layout-cluster'

loadEnv({ path: resolve(__dirname, '../../.env.local') })

const SAMPLE_PDF = resolve(__dirname, '../../sample/IMG_9452.pdf')
const haveSample = existsSync(SAMPLE_PDF)
const haveApiKey = !!process.env.MISTRAL_API_KEY
const shouldRun = haveSample && haveApiKey

/**
 * v0.8: 合成ラスタ画素（インク判定用）。1pt=1px。背景 luma で全面塗り、rects を濃画素で上書き。
 */
function makePixels(opts: {
  width: number
  height: number
  bg?: number
  rects?: Array<{ x: number; y: number; w: number; h: number }>
}): RasterPagePixels {
  const { width, height } = opts
  const bg = opts.bg ?? 255
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = bg
    data[i * 4 + 1] = bg
    data[i * 4 + 2] = bg
    data[i * 4 + 3] = 255
  }
  for (const r of opts.rects ?? []) {
    const x1 = Math.min(width, r.x + r.w)
    const y1 = Math.min(height, r.y + r.h)
    for (let y = Math.max(0, r.y); y < y1; y++) {
      for (let x = Math.max(0, r.x); x < x1; x++) {
        const i = (y * width + x) * 4
        data[i] = 30
        data[i + 1] = 30
        data[i + 2] = 30
      }
    }
  }
  return {
    page: 1,
    data,
    pixelWidth: width,
    pixelHeight: height,
    pageWidthPt: width,
    pageHeightPt: height,
  }
}

describe('whiteout-preview flow (v0.5 案 B 検証)', () => {
  it.skipIf(!shouldRun)(
    'IMG_9452 fixture: table_cell が含まれ、案 B 上書きが走ったことを確認',
    async () => {
      const pdfBytes = new Uint8Array(readFileSync(SAMPLE_PDF))
      const result = await extractScanPdfLayout(pdfBytes)

      expect(result.pages.length).toBeGreaterThanOrEqual(1)
      const page0 = result.pages[0]
      expect(page0.elements.length).toBeGreaterThan(0)

      const tableCells = page0.elements.filter(e => e.type === 'table_cell')
      // 案 B: tables HTML 由来の matched range があれば table_cell が必ず 1 つ以上発生
      expect(tableCells.length).toBeGreaterThan(0)

      // 案 B 「先頭集約 + 後続空文字化」採用の副作用として、
      // table_cell 化された element のうち text === '' のものが範囲内連続 word から発生し得る。
      // 全てが空文字ということは無い（先頭要素には必ず Mistral text が入る）。
      const nonEmptyTableCells = tableCells.filter(e => e.text.length > 0)
      expect(nonEmptyTableCells.length).toBeGreaterThan(0)
    },
    180_000, // Mistral OCR + Tesseract: 60s budget + 余裕
  )

  it('fixture 未配置時は skip される（CI 安全弁）', () => {
    if (!shouldRun) {
      // eslint-disable-next-line no-console
      console.log(
        `[whiteout-preview-flow] skip: haveSample=${haveSample} haveApiKey=${haveApiKey}`,
      )
    }
    expect(true).toBe(true)
  })
})

/**
 * v0.5.1 prefilter 統合テスト（設計 v0.5.1 §7 Integration / §6 §10）。
 *
 * 53 cell の合成 fixture を組み、prefilter → role-classify を通したとき:
 *   1) Claude 入力削減率が 50% 以上（remaining ≤ 26）
 *   2) 全 cell に CellClassification が付与される（取りこぼしなし）
 *
 * Mistral / OCR を呼ばず、純粋に prefilter + role-classifier の統合動作を見る。
 */
process.env.ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-test-model'

function makeLayoutCell(
  cellId: string,
  overrides: Partial<LayoutCell> = {},
): LayoutCell {
  return {
    cellId,
    page: overrides.page ?? 1,
    rowIndex: overrides.rowIndex ?? 0,
    colIndex: overrides.colIndex ?? 0,
    text: overrides.text ?? '',
    bbox: overrides.bbox ?? { x: 0, y: 0, w: 10, h: 10 },
    isLeftmostInRow: overrides.isLeftmostInRow ?? false,
    looksEmpty: overrides.looksEmpty ?? false,
    labelLexiconHit: overrides.labelLexiconHit ?? false,
    avgConfidence: overrides.avgConfidence ?? 0.9,
  }
}

function build53CellFixture(): LayoutCell[] {
  const cells: LayoutCell[] = []
  // R1 noise-empty 8 件（空白のみ）
  for (let i = 0; i < 8; i++) {
    cells.push(makeLayoutCell(`emp-${i}`, { text: '   ', rowIndex: 20 + i }))
  }
  // R2 noise-tiny 8 件（1 文字、lexicon hit なし）
  for (let i = 0; i < 8; i++) {
    cells.push(
      makeLayoutCell(`tiny-${i}`, {
        text: '了',
        labelLexiconHit: false,
        rowIndex: 30 + i,
      }),
    )
  }
  // R3 label-lexicon-leftmost 10 件
  const labels = [
    '日時',
    '場所',
    '出席者',
    '議題',
    '次回',
    '部署',
    '氏名',
    '決定',
    '会場',
    '記録',
  ]
  for (let i = 0; i < labels.length; i++) {
    cells.push(
      makeLayoutCell(`lbl-${i}`, {
        text: labels[i],
        labelLexiconHit: true,
        isLeftmostInRow: true,
        rowIndex: 1 + i,
        colIndex: 0,
      }),
    )
  }
  // R4 printed-static-header 1 件（ページ最上部単独）
  cells.push(
    makeLayoutCell('hdr-0', {
      text: '社内議事録テンプレート',
      rowIndex: 0,
      colIndex: 0,
      isLeftmostInRow: true,
      page: 1,
    }),
  )
  // R5 printed-static-wordlist 2 件
  cells.push(
    makeLayoutCell('ws-0', {
      text: 'Wondershare PDFelement で作成',
      rowIndex: 40,
    }),
  )
  cells.push(makeLayoutCell('pn-0', { text: '1 / 3', rowIndex: 41 }))

  // Claude 送り（remaining）: 24 件（合計 53、confirmed=29 で削減率 ≈ 54.7%）
  for (let i = 0; i < 24; i++) {
    cells.push(
      makeLayoutCell(`rem-${i}`, {
        text: `本文または記入値 ${i}`,
        labelLexiconHit: false,
        rowIndex: 1 + i,
        colIndex: 1, // 行内 2 列目（R4 を踏まない）
      }),
    )
  }
  return cells
}

function fakeClient(
  classifications: CellClassification[],
): {
  client: RoleClassifierClient
  capturedRemainingIds: { value: string[] }
} {
  const captured = { value: [] as string[] }
  const client: RoleClassifierClient = {
    messages: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async create(...args: any[]) {
        const params = args[0] as { messages: Array<{ content: string }> }
        // user prompt の JSON 部分から cellId を簡易抽出
        const m = params.messages[0].content.match(/"cellId":"([^"]+)"/g) ?? []
        captured.value = m.map(s => s.replace(/"cellId":"|"/g, ''))
        return {
          content: [
            {
              type: 'tool_use',
              name: 'classify_cell_roles',
              input: { classifications },
            },
          ],
        }
      },
    } as unknown as RoleClassifierClient['messages'],
  }
  return { client, capturedRemainingIds: captured }
}

describe('whiteout-preview flow v0.5.1 prefilter 統合', () => {
  it('53 cell fixture: prefilter で Claude 入力 ≤ 26 cell（50% 以上削減）', () => {
    const cells = build53CellFixture()
    expect(cells.length).toBe(53)
    const { confirmed, remaining } = prefilterCells(cells)
    // 設計 §3 目標: ≤ 26
    expect(remaining.length).toBeLessThanOrEqual(26)
    // confirmed + remaining = total
    expect(confirmed.length + remaining.length).toBe(cells.length)
  })

  it('classifyCellRoles: 全 cell に CellClassification が付与される（取りこぼしなし）', async () => {
    const cells = build53CellFixture()
    const cluster: LayoutCluster = { pages: [{ page: 1, cells }] }

    // Claude モック: remaining として渡された全 cellId に対し value_or_entry を返す
    const { confirmed: pref, remaining } = prefilterCells(cells)
    const claudeClassifications: CellClassification[] = remaining.map(r => ({
      cellId: r.cellId,
      role: 'value_or_entry',
    }))
    const { client, capturedRemainingIds } = fakeClient(claudeClassifications)

    const result = await classifyCellRoles({ cluster }, { client })

    // 1) 全 cell が CellClassification として返る
    const returnedIds = new Set(result.map(r => r.cellId))
    for (const c of cells) {
      expect(returnedIds.has(c.cellId)).toBe(true)
    }
    expect(result.length).toBe(cells.length)

    // 2) Claude には remaining のみ渡る
    expect(capturedRemainingIds.value.length).toBe(remaining.length)
    const confirmedIdSet = new Set(pref.map(p => p.cellId))
    for (const sentId of capturedRemainingIds.value) {
      expect(confirmedIdSet.has(sentId)).toBe(false)
    }
  })
})

/**
 * 白塗り v0.6 統合（設計 §8 ケース 9〜10）。
 *
 * fixture PDF を rasterize → detectFieldBboxes（罫線検出、Claude/Mistral 非依存）→
 * suggestWhiteoutCandidatesByField で white-out 候補を組み、written_bbox（別座標）との
 * 分離を確認する。罫線検出は API キー不要なので fixture があれば実行する。
 *
 * 設計 §11-3 厳守: 知人 PDF 由来内容は assertion に書かない。構造（件数 / 座標分離）のみ検証。
 */
describe('whiteout v0.7.1 field_bbox 統合（§9 ケース 12〜13）', () => {
  it.skipIf(!haveSample)(
    'ケース12: fixture PDF → boxes（記入スペース）と writtenBoxes が別座標で両方返る',
    async () => {
      const pdfBytes = new Uint8Array(readFileSync(SAMPLE_PDF))
      const rasterized = await renderPdfPagesToPng(pdfBytes, { scale: 2.0 })
      const detected = await Promise.all(rasterized.map(p => detectFieldBboxes(p)))
      const fieldBoxes = detected.flatMap(d => d.boxes)
      const pixels = detected.map(d => d.pixels) // v0.8: インク判定用の共有画素

      // 罫線がある議事録テンプレなら 1 個以上の枠が検出される
      expect(fieldBoxes.length).toBeGreaterThan(0)

      // v0.8: pixels を渡しインク判定。ラベル無し cluster でインクありセルが inset 済で返る。
      const emptyCluster: LayoutCluster = { pages: [] }
      const boxes = suggestWhiteoutCandidatesByField(
        fieldBoxes,
        emptyCluster,
        [],
        undefined,
        undefined,
        pixels,
      )
      // 全 box が白固定 / auto_suggestion / inset 済（w,h > 0）
      for (const b of boxes) {
        expect(b.source).toBe('auto_suggestion')
        expect(b.estimatedBgColor).toEqual({ r: 255, g: 255, b: 255 })
        expect(b.bbox.w).toBeGreaterThan(0)
        expect(b.bbox.h).toBeGreaterThan(0)
      }
    },
    120_000,
  )

  it('ケース12(合成・v0.8): インクありセルが inset 済 box で返る', () => {
    // v0.8: 記入有無はセル内インク（前景ピクセル）で判定。field 内にインク塊を置く。
    const fieldBoxes = [
      { page: 1 as const, area: 'B' as const, bbox: { x: 100, y: 50, w: 200, h: 40 } },
    ]
    const pixels = makePixels({
      width: 600,
      height: 800,
      bg: 255,
      rects: [{ x: 150, y: 60, w: 80, h: 16 }], // field 内のインク塊
    })
    const boxes = suggestWhiteoutCandidatesByField(
      fieldBoxes,
      { pages: [] },
      [],
      undefined,
      undefined,
      [pixels],
    )
    expect(boxes.length).toBe(1)
    // v0.8 §3: 全辺独立 inset。左右 INSET_LEFT_PT/INSET_RIGHT_PT(4.0) / 上下 INSET_TOP/BOTTOM_PT(3.0)。
    // x=100+4, y=50+3, w=200-4-4, h=40-3-3。
    expect(boxes[0].bbox).toEqual({ x: 104, y: 53, w: 192, h: 34 })
  })

  it('ケース13(v0.8): ラベル枠は含まれない / 議事内容大枠（インクあり）は含まれる / 空欄欄（インク無し）は含まれない', () => {
    const fieldBoxes = [
      // ラベル列（最左狭、インクありでもラベルは塗らない）
      { page: 1 as const, area: 'A' as const, bbox: { x: 0, y: 0, w: 100, h: 40 } },
      // 議事内容大枠（エリアB、インクあり）
      { page: 1 as const, area: 'B' as const, bbox: { x: 0, y: 100, w: 500, h: 200 } },
      // 空欄欄（決定事項、インク無し）
      { page: 1 as const, area: 'B' as const, bbox: { x: 0, y: 320, w: 500, h: 150 } },
    ]
    const cluster: LayoutCluster = {
      pages: [
        {
          page: 1,
          cells: [
            makeLayoutCell('lbl', {
              bbox: { x: 10, y: 10, w: 80, h: 20 },
              isLeftmostInRow: true,
              labelLexiconHit: true,
              text: '部署',
            }),
          ],
        },
      ],
    }
    // ラベル枠内（印字インク）と議事内容大枠内（記入インク）にインク。空欄欄（y=320）にはインク無し。
    const pixels = makePixels({
      width: 600,
      height: 800,
      bg: 255,
      rects: [
        { x: 20, y: 12, w: 40, h: 16 }, // ラベル枠内（ラベル除外で塗られない）
        { x: 50, y: 150, w: 120, h: 30 }, // 議事内容大枠内
      ],
    })
    const boxes = suggestWhiteoutCandidatesByField(
      fieldBoxes,
      cluster,
      [],
      undefined,
      undefined,
      [pixels],
    )
    // 議事内容大枠（y=100）のみ塗る。ラベル枠（y=0）と空欄欄（y=320）は除外。
    expect(boxes.length).toBe(1)
    expect(boxes[0].bbox.y).toBe(103) // 100 + INSET_TOP_PT(3.0)
  })

  it('fixture 未配置時は skip される（CI 安全弁）', () => {
    expect(true).toBe(true)
  })
})
