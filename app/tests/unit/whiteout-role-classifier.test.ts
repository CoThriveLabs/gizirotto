/**
 * whiteout-role-classifier unit test（白塗り v0.5.1 §7 / 設計 §4 §12）。
 *
 * 検証対象（v0.5.1 改修分）:
 *   - classifyCellRoles 冒頭の prefilterCells 経由で remaining のみが Claude に渡ること
 *   - confirmed と Claude 応答の和集合が CellClassification[] として返ること
 *   - cellId 重複時は confirmed が優先されること
 *   - buildUserPrompt の text が PREFILTER_TEXT_TRUNCATE_LEN 字で truncate されること
 *
 * 設計 §4: classifyCellRoles の入出力契約（CellClassification[] を返す）は変更しない。
 */
import { describe, it, expect } from 'vitest'
import {
  classifyCellRoles,
  type RoleClassifierClient,
  type CellClassification,
} from '@/lib/parsers/pdf/whiteout-role-classifier'
import type {
  LayoutCluster,
  LayoutCell,
} from '@/lib/parsers/pdf/layout-cluster'

process.env.ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-test-model'

function lc(overrides: Partial<LayoutCell> & { cellId: string }): LayoutCell {
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

function clusterOf(cells: LayoutCell[]): LayoutCluster {
  // 同じ page にまとめる（テストは page=1 固定で OK）
  const pageNo = cells[0]?.page ?? 1
  return { pages: [{ page: pageNo, cells }] }
}

function fakeClientReturning(classifications: CellClassification[]): {
  client: RoleClassifierClient
  capturedParams: { value: unknown }
} {
  const captured: { value: unknown } = { value: undefined }
  const client: RoleClassifierClient = {
    messages: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async create(...args: any[]) {
        captured.value = args[0]
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
  return { client, capturedParams: captured }
}

describe('classifyCellRoles - v0.5.1 prefilter 統合', () => {
  it('prefilter で全 cell が confirmed なら Claude を呼ばない', async () => {
    const cells: LayoutCell[] = [
      lc({ cellId: 'p1-r0-c0', text: '   ' }), // R1
      lc({
        cellId: 'p1-r1-c0',
        text: '日時',
        labelLexiconHit: true,
        isLeftmostInRow: true,
        rowIndex: 1,
      }), // R3
    ]
    const { client, capturedParams } = fakeClientReturning([])
    const result = await classifyCellRoles(
      { cluster: clusterOf(cells) },
      { client },
    )
    expect(result).toHaveLength(2)
    // Claude は呼ばれない（params 未キャプチャ）
    expect(capturedParams.value).toBeUndefined()
    const map = new Map(result.map(r => [r.cellId, r.role]))
    expect(map.get('p1-r0-c0')).toBe('noise')
    expect(map.get('p1-r1-c0')).toBe('label')
  })

  it('Claude には prefilter の remaining のみが渡る', async () => {
    const cells: LayoutCell[] = [
      lc({ cellId: 'p1-r0-c0', text: '   ' }), // R1 confirmed
      lc({
        cellId: 'p1-r2-c1',
        text: '社用車30ヶ月点検と買取り査定について',
        labelLexiconHit: false,
        rowIndex: 2,
        colIndex: 1,
      }), // remaining
    ]
    const { client, capturedParams } = fakeClientReturning([
      { cellId: 'p1-r2-c1', role: 'value_or_entry' },
    ])
    const result = await classifyCellRoles(
      { cluster: clusterOf(cells) },
      { client },
    )
    expect(result).toHaveLength(2)
    // Claude プロンプト中の JSON に remaining cellId のみが含まれること
    const params = capturedParams.value as {
      messages: Array<{ content: string }>
    }
    const userText = params.messages[0].content
    expect(userText).toContain('p1-r2-c1')
    expect(userText).not.toContain('p1-r0-c0')
  })

  it('Claude へ渡す text は PREFILTER_TEXT_TRUNCATE_LEN(50) 字で truncate される', async () => {
    const longText = 'あ'.repeat(80) // 50 字超
    const cells: LayoutCell[] = [
      lc({
        cellId: 'p1-r3-c1',
        text: longText,
        rowIndex: 3,
        colIndex: 1,
      }),
    ]
    const { client, capturedParams } = fakeClientReturning([
      { cellId: 'p1-r3-c1', role: 'value_or_entry' },
    ])
    await classifyCellRoles({ cluster: clusterOf(cells) }, { client })
    const params = capturedParams.value as {
      messages: Array<{ content: string }>
    }
    const userText = params.messages[0].content
    // 50 字の「あ」が連なる文字列は含まれるが、51 字以上連続する「あ」は含まれない
    expect(userText).toContain('あ'.repeat(50))
    expect(userText).not.toContain('あ'.repeat(51))
  })

  it('confirmed と Claude 応答がマージされて全 cell の CellClassification が返る', async () => {
    const cells: LayoutCell[] = [
      lc({
        cellId: 'p1-r1-c0',
        text: '日時',
        labelLexiconHit: true,
        isLeftmostInRow: true,
        rowIndex: 1,
      }), // R3 confirmed=label
      lc({
        cellId: 'p1-r1-c1',
        text: '令和7年5月6日(金)',
        rowIndex: 1,
        colIndex: 1,
      }), // remaining
    ]
    const { client } = fakeClientReturning([
      { cellId: 'p1-r1-c1', role: 'value_or_entry' },
    ])
    const result = await classifyCellRoles(
      { cluster: clusterOf(cells) },
      { client },
    )
    const map = new Map(result.map(r => [r.cellId, r.role]))
    expect(map.get('p1-r1-c0')).toBe('label')
    expect(map.get('p1-r1-c1')).toBe('value_or_entry')
    expect(result).toHaveLength(2)
  })

  it('cellId 重複時は confirmed が優先される（Claude の応答が confirmed を上書きしない）', async () => {
    const cells: LayoutCell[] = [
      lc({
        cellId: 'p1-r1-c0',
        text: '日時',
        labelLexiconHit: true,
        isLeftmostInRow: true,
        rowIndex: 1,
      }), // confirmed=label
      lc({
        cellId: 'p1-r2-c0',
        text: '本文',
        rowIndex: 2,
      }), // remaining
    ]
    // Claude が誤って confirmed cellId に対しても classification を返してきた場合
    const { client } = fakeClientReturning([
      { cellId: 'p1-r1-c0', role: 'value_or_entry' }, // 重複: 無視される
      { cellId: 'p1-r2-c0', role: 'value_or_entry' },
    ])
    const result = await classifyCellRoles(
      { cluster: clusterOf(cells) },
      { client },
    )
    const map = new Map(result.map(r => [r.cellId, r.role]))
    expect(map.get('p1-r1-c0')).toBe('label') // confirmed 優先
    expect(map.get('p1-r2-c0')).toBe('value_or_entry')
    expect(result).toHaveLength(2)
  })

  it('cells が空なら Claude を呼ばずに空配列を返す（既存契約）', async () => {
    const { client, capturedParams } = fakeClientReturning([])
    const result = await classifyCellRoles(
      { cluster: { pages: [] } },
      { client },
    )
    expect(result).toEqual([])
    expect(capturedParams.value).toBeUndefined()
  })
})
