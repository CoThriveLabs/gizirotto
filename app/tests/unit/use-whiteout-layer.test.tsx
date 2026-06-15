/**
 * useWhiteoutLayer フックの結合テスト（Phase 7 S3・白塗りレイヤ抽出の関所）。
 *
 * 検証する不変条件（hook が useLayerEditor を正しく配線していること）:
 *   - undo: applyNudge 後に undo で元位置に戻る
 *   - redo: undo 後に redo で進んだ位置に戻る
 *   - dirty: init 直後は false・applyNudge で true
 *   - drag: changed=false → undoStack 増えない / changed=true → undoStack +1
 */
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useWhiteoutLayer } from '@/hooks/editor/useWhiteoutLayer'
import type { EditorField } from '@/app/(dashboard)/templates/[id]/bbox-pane'
import type { WhiteoutMeta } from '@/lib/pdf-output/whiteout-adapter'
import type { PageMeta } from '@/lib/pdf-output/bbox-coords'

const PAGE_SIZES: PageMeta[] = [
  { page: 1, widthPt: 595, heightPt: 842, pixelWidth: 595, pixelHeight: 842 },
]

function makeField(name: string): EditorField {
  return { name, label: '', bbox: { x: 50, y: 100, w: 200, h: 30, page: 1 } }
}

function makeMeta(): Map<string, WhiteoutMeta> {
  return new Map([
    ['wo_0', { source: 'manual', estimatedBgColor: { r: 255, g: 255, b: 255 } }],
  ])
}

const INIT_FIELDS: EditorField[] = [makeField('wo_0')]

/** params の本体注入分はテスト用 no-op で埋め、hook 単体の挙動に集中する。 */
function setup() {
  const hook = renderHook(() =>
    useWhiteoutLayer({
      templateId: 't-1',
      pageSizes: PAGE_SIZES,
      refetchBackgrounds: async () => {},
      setBodyErrorMsg: () => {},
    }),
  )
  // init で fields/meta/snapshot を確定（初回ロード effect 相当）。
  act(() => hook.result.current.init(INIT_FIELDS, makeMeta()))
  return hook
}

describe('useWhiteoutLayer 結合テスト', () => {
  describe('undo', () => {
    it('applyNudge 後に undo で元位置に戻る', () => {
      const { result } = setup()
      act(() => result.current.setSelectedName('wo_0'))
      act(() => result.current.applyNudge('move-right'))

      const moved = result.current.fields.find((f) => f.name === 'wo_0')
      expect(moved?.bbox.x).toBe(51)
      expect(result.current.canUndo).toBe(true)

      act(() => result.current.undo())
      const back = result.current.fields.find((f) => f.name === 'wo_0')
      expect(back?.bbox.x).toBe(50)
      expect(result.current.canUndo).toBe(false)
    })
  })

  describe('redo', () => {
    it('undo 後に redo で進んだ位置に戻る', () => {
      const { result } = setup()
      act(() => result.current.setSelectedName('wo_0'))
      act(() => result.current.applyNudge('move-right'))
      act(() => result.current.undo())

      expect(result.current.fields.find((f) => f.name === 'wo_0')?.bbox.x).toBe(50)
      expect(result.current.canRedo).toBe(true)

      act(() => result.current.redo())
      expect(result.current.fields.find((f) => f.name === 'wo_0')?.bbox.x).toBe(51)
      expect(result.current.canRedo).toBe(false)
    })
  })

  describe('dirty', () => {
    it('init 直後は dirty=false、applyNudge で true', () => {
      const { result } = setup()
      expect(result.current.dirty).toBe(false)
      act(() => result.current.setSelectedName('wo_0'))
      act(() => result.current.applyNudge('move-right'))
      expect(result.current.dirty).toBe(true)
    })
  })

  describe('drag', () => {
    it('ドラッグ開始 → 変化なし確定（changed=false）→ undoStack が増えない', () => {
      const { result } = setup()
      expect(result.current.canUndo).toBe(false)

      act(() => result.current.onDragStart())
      act(() => result.current.onDragCommit('wo_0', false))
      expect(result.current.canUndo).toBe(false)
    })

    it('ドラッグ確定（changed=true）→ undoStack +1・undo でドラッグ前に戻る', () => {
      const { result } = setup()

      act(() => result.current.onDragStart())
      act(() =>
        result.current.applyBbox('wo_0', {
          x: 120,
          y: 100,
          w: 200,
          h: 30,
          page: 1,
        }),
      )
      act(() => result.current.onDragCommit('wo_0', true))

      expect(result.current.fields.find((f) => f.name === 'wo_0')?.bbox.x).toBe(120)
      expect(result.current.canUndo).toBe(true)

      act(() => result.current.undo())
      expect(result.current.fields.find((f) => f.name === 'wo_0')?.bbox.x).toBe(50)
    })
  })
})
