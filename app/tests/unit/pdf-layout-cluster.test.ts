/**
 * layout-cluster + role ベース白塗りサジェスト unit test（白塗り v0.4 / §2-4）。
 *
 * - buildLayoutCluster: ScanElement[] を行クラスタ→列分割→cells に復元
 * - suggestWhiteoutCandidatesByRole: role==='value_or_entry' のみ白塗り対象化
 */
import { describe, it, expect } from 'vitest'
import { buildLayoutCluster } from '@/lib/parsers/pdf/layout-cluster'
import { suggestWhiteoutCandidatesByRole } from '@/lib/parsers/pdf/whiteout-pipeline'
import type { ScanOcrResult, ScanElement } from '@/lib/parsers/pdf/scan-extractor'
import type { CellClassification } from '@/lib/parsers/pdf/whiteout-role-classifier'

function el(
  text: string,
  x: number,
  y: number,
  w: number,
  h: number,
  confidence = 0.9,
): ScanElement {
  return {
    type: 'printed_text',
    text,
    bbox: { x, y, w, h },
    confidence,
    source: 'tesseract_only',
  }
}

function ocrFrom(elements: ScanElement[]): ScanOcrResult {
  return {
    pages: [
      {
        pageIndex: 0,
        pageSize: { widthPt: 595, heightPt: 842 },
        sourceMarkdown: '',
        elements,
      },
    ],
  }
}

describe('layout-cluster.buildLayoutCluster', () => {
  it('同じ y の要素は同一行に束ねられる', () => {
    // 「氏名」（左）と「山田太郎」（右、十分離れている）= 1 行 2 列
    const ocr = ocrFrom([
      el('氏名', 50, 100, 40, 20),
      el('山田太郎', 200, 100, 80, 20),
    ])
    const cluster = buildLayoutCluster(ocr)
    expect(cluster.pages).toHaveLength(1)
    const cells = cluster.pages[0].cells
    // 1 行に束ね、x ギャップで 2 列に分割される
    const row0 = cells.filter(c => c.rowIndex === 0)
    expect(row0.length).toBeGreaterThanOrEqual(2)
    const leftmost = row0.find(c => c.isLeftmostInRow)
    expect(leftmost?.text).toContain('氏名')
  })

  it('y が大きく異なる要素は別の行になる', () => {
    const ocr = ocrFrom([
      el('日時', 50, 100, 40, 20),
      el('場所', 50, 300, 40, 20),
    ])
    const cluster = buildLayoutCluster(ocr)
    const rowIndices = new Set(cluster.pages[0].cells.map(c => c.rowIndex))
    expect(rowIndices.size).toBe(2)
  })

  it('ラベル語彙ヒットが立つ', () => {
    const ocr = ocrFrom([el('出席者', 50, 100, 60, 20)])
    const cluster = buildLayoutCluster(ocr)
    const cell = cluster.pages[0].cells[0]
    expect(cell.labelLexiconHit).toBe(true)
  })

  it('cellId は一意で page/row/col を含む', () => {
    const ocr = ocrFrom([
      el('氏名', 50, 100, 40, 20),
      el('山田', 200, 100, 60, 20),
    ])
    const cluster = buildLayoutCluster(ocr)
    const ids = cluster.pages[0].cells.map(c => c.cellId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids[0]).toMatch(/^p1-r\d+-c\d+$/)
  })
})

describe('whiteout-pipeline.suggestWhiteoutCandidatesByRole', () => {
  it('value_or_entry のみ白塗り対象になり label/printed_static は除外される', () => {
    const ocr = ocrFrom([
      el('氏名', 50, 100, 40, 20),
      el('山田太郎', 200, 100, 80, 20),
    ])
    const cluster = buildLayoutCluster(ocr)
    const cells = cluster.pages[0].cells
    const labelCell = cells.find(c => c.text.includes('氏名'))!
    const valueCell = cells.find(c => c.text.includes('山田'))!

    const classifications: CellClassification[] = [
      { cellId: labelCell.cellId, role: 'label' },
      { cellId: valueCell.cellId, role: 'value_or_entry' },
    ]
    const boxes = suggestWhiteoutCandidatesByRole(cluster, classifications)
    expect(boxes).toHaveLength(1)
    // 白塗り対象は value セルの bbox（ラベルは塗らない = 誤検出解消）
    expect(boxes[0].bbox.x).toBe(valueCell.bbox.x)
  })

  it('classification が無いセルは塗らない', () => {
    const ocr = ocrFrom([el('会議議事録', 250, 40, 100, 30)])
    const cluster = buildLayoutCluster(ocr)
    const boxes = suggestWhiteoutCandidatesByRole(cluster, [])
    expect(boxes).toHaveLength(0)
  })

  it('targetRoles を広げると printed_static も対象にできる', () => {
    const ocr = ocrFrom([el('タイトル', 250, 40, 100, 30)])
    const cluster = buildLayoutCluster(ocr)
    const cell = cluster.pages[0].cells[0]
    const classifications: CellClassification[] = [
      { cellId: cell.cellId, role: 'printed_static' },
    ]
    const none = suggestWhiteoutCandidatesByRole(cluster, classifications)
    expect(none).toHaveLength(0)
    const withStatic = suggestWhiteoutCandidatesByRole(cluster, classifications, [
      'value_or_entry',
      'printed_static',
    ])
    expect(withStatic).toHaveLength(1)
  })
})
