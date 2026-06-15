/**
 * whiteout-prefilter unit test（白塗り v0.5.1 §7 Unit / 9 ケース）。
 *
 * 設計 §2 表 R1〜R5 順次評価のロジックを最小単位で固める。
 * confirmed / remaining 集合の和 = 元 cells を維持し、Claude 入力削減経路の安全性を担保する。
 */
import { describe, it, expect } from 'vitest'
import {
  prefilterCells,
  PRINTED_STATIC_PATTERNS,
  PREFILTER_TEXT_TRUNCATE_LEN,
} from '@/lib/parsers/pdf/whiteout-prefilter'
import type { LayoutCell } from '@/lib/parsers/pdf/layout-cluster'

function cell(overrides: Partial<LayoutCell> & { cellId: string }): LayoutCell {
  return {
    cellId: overrides.cellId,
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

describe('whiteout-prefilter.prefilterCells', () => {
  // Case 1: R1 空白のみ → noise
  it('R1: 空白のみは noise 確定', () => {
    const cells = [cell({ cellId: 'p1-r5-c2', text: '   \t \n ' })]
    const result = prefilterCells(cells)
    expect(result.confirmed).toHaveLength(1)
    expect(result.confirmed[0]).toEqual({ cellId: 'p1-r5-c2', role: 'noise' })
    expect(result.remaining).toHaveLength(0)
  })

  // Case 2: R2 1 文字 + lexicon hit なし → noise
  it('R2: 1 文字かつ labelLexiconHit=false は noise 確定', () => {
    const cells = [
      cell({
        cellId: 'p1-r3-c1',
        text: '了',
        labelLexiconHit: false,
        rowIndex: 3,
      }),
    ]
    const result = prefilterCells(cells)
    expect(result.confirmed).toHaveLength(1)
    expect(result.confirmed[0].role).toBe('noise')
    expect(result.remaining).toHaveLength(0)
  })

  // Case 3: R2 1 文字 + lexicon hit あり → Claude 送り（noise 確定しない）
  it('R2: 1 文字でも labelLexiconHit=true なら Claude へ送る', () => {
    // labelLexiconHit が独立した hint として渡されている前提
    // （cluster ビルダ側で「日」「場」等の単漢字をヒットさせる将来拡張に耐える）
    const cells = [
      cell({
        cellId: 'p1-r2-c0',
        text: '日',
        labelLexiconHit: true,
        isLeftmostInRow: false,
        rowIndex: 2,
      }),
    ]
    const result = prefilterCells(cells)
    expect(result.confirmed).toHaveLength(0)
    expect(result.remaining).toHaveLength(1)
    expect(result.remaining[0].cellId).toBe('p1-r2-c0')
  })

  // Case 4: R3 labelLexiconHit + isLeftmostInRow=true → label
  it('R3: labelLexiconHit=true かつ isLeftmostInRow=true は label 確定', () => {
    const cells = [
      cell({
        cellId: 'p1-r1-c0',
        text: '日時',
        labelLexiconHit: true,
        isLeftmostInRow: true,
        rowIndex: 1,
      }),
    ]
    const result = prefilterCells(cells)
    expect(result.confirmed).toHaveLength(1)
    expect(result.confirmed[0]).toEqual({ cellId: 'p1-r1-c0', role: 'label' })
    expect(result.remaining).toHaveLength(0)
  })

  // Case 5: R3 labelLexiconHit=true だが isLeftmostInRow=false → Claude 送り
  it('R3: labelLexiconHit=true でも isLeftmostInRow=false なら Claude 送り', () => {
    const cells = [
      cell({
        cellId: 'p1-r4-c2',
        text: '次回',
        labelLexiconHit: true,
        isLeftmostInRow: false,
        rowIndex: 4,
        colIndex: 2,
      }),
    ]
    const result = prefilterCells(cells)
    expect(result.confirmed).toHaveLength(0)
    expect(result.remaining).toHaveLength(1)
  })

  // Case 6: R4 ページ最上部単独 cell → printed_static
  it('R4: rowIndex=0 / colIndex=0 で行内唯一 + text.length>=4 + lexicon hit なし → printed_static', () => {
    const cells = [
      cell({
        cellId: 'p1-r0-c0',
        text: '議事録テンプレート',
        labelLexiconHit: false,
        rowIndex: 0,
        colIndex: 0,
        isLeftmostInRow: true,
      }),
    ]
    const result = prefilterCells(cells)
    expect(result.confirmed).toHaveLength(1)
    expect(result.confirmed[0]).toEqual({
      cellId: 'p1-r0-c0',
      role: 'printed_static',
    })
  })

  // Case 7: R5 含有 → printed_static（PRINTED_STATIC_PATTERNS の string パターン）
  it('R5: PRINTED_STATIC_PATTERNS 含有（"Wondershare PDFelement で作成"）→ printed_static', () => {
    const cells = [
      cell({
        cellId: 'p2-r10-c0',
        text: 'Wondershare PDFelement で作成',
        rowIndex: 10,
      }),
    ]
    const result = prefilterCells(cells)
    expect(result.confirmed).toHaveLength(1)
    expect(result.confirmed[0].role).toBe('printed_static')
    // PRINTED_STATIC_PATTERNS に 'Wondershare' 文字列が含まれている前提を確認
    expect(PRINTED_STATIC_PATTERNS).toContain('Wondershare')
  })

  // Case 8: どのルールにも該当しない通常 cell → Claude 送り
  it('どのルールにも該当しない通常 cell は Claude 送り', () => {
    const cells = [
      cell({
        cellId: 'p1-r5-c1',
        text: '社用車30ヶ月点検と買取り査定について',
        labelLexiconHit: false,
        rowIndex: 5,
        colIndex: 1,
      }),
    ]
    const result = prefilterCells(cells)
    expect(result.confirmed).toHaveLength(0)
    expect(result.remaining).toHaveLength(1)
    expect(result.remaining[0].cellId).toBe('p1-r5-c1')
  })

  // Case 9: confirmed と remaining の cellId 集合に重複・欠落がないこと（union が全体と一致）
  it('confirmed と remaining の cellId 和集合は元 cells の cellId 集合に一致する', () => {
    const cells: LayoutCell[] = [
      cell({ cellId: 'a', text: '   ' }), // R1
      cell({
        cellId: 'b',
        text: '了',
        labelLexiconHit: false,
        rowIndex: 1,
      }), // R2
      cell({
        cellId: 'c',
        text: '日時',
        labelLexiconHit: true,
        isLeftmostInRow: true,
        rowIndex: 2,
      }), // R3
      cell({
        cellId: 'd',
        text: '議事録テンプレート',
        rowIndex: 0,
        colIndex: 0,
        labelLexiconHit: false,
      }), // R4
      cell({
        cellId: 'e',
        text: 'Wondershare PDFelement で作成',
        rowIndex: 10,
      }), // R5
      cell({
        cellId: 'f',
        text: '普通の本文。R1-R5 のどれにも当てはまらない。',
        rowIndex: 7,
      }), // remaining
    ]
    const result = prefilterCells(cells)
    const allIds = new Set(cells.map(c => c.cellId))
    const merged = new Set([
      ...result.confirmed.map(c => c.cellId),
      ...result.remaining.map(c => c.cellId),
    ])
    expect(merged).toEqual(allIds)
    // 重複なし: confirmed と remaining の cellId が交差していない
    const confirmedIds = new Set(result.confirmed.map(c => c.cellId))
    const remainingIds = new Set(result.remaining.map(c => c.cellId))
    for (const id of confirmedIds) {
      expect(remainingIds.has(id)).toBe(false)
    }
  })

  // 補助: TRUNCATE_LEN 定数は 50 で固定（設計 §2 / §13-2）
  it('PREFILTER_TEXT_TRUNCATE_LEN は 50 で公開されている', () => {
    expect(PREFILTER_TEXT_TRUNCATE_LEN).toBe(50)
  })
})
