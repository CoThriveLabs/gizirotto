/**
 * useFieldLayerEditor フックの結合テスト（Phase 7 S2・記入欄レイヤ抽出の関所）。
 *
 * 検証する不変条件（hook が undo-stack 純ロジックを正しく配線していること）:
 *   - undo coalesce: 同一 selectedName の nudge 600ms 内連打が 1 ステップに畳まれる
 *   - dragPreSnapshot: クリックのみ（changed=false）は undoStack を増やさない
 *   - drag 確定: changed=true で undoStack +1・undo でドラッグ前に戻る
 *   - dirty: init 直後は false・fields 変更で true（useMemo）
 */
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useFieldLayerEditor } from '@/hooks/editor/useFieldLayerEditor'
import type { EditorField } from '@/app/(dashboard)/templates/[id]/bbox-pane'
import type { PageMeta } from '@/lib/pdf-output/bbox-coords'

const PAGE_SIZES: PageMeta[] = [
  { page: 1, widthPt: 595, heightPt: 842, pixelWidth: 595, pixelHeight: 842 },
]

function makeField(name: string): EditorField {
  return { name, label: name, bbox: { x: 50, y: 100, w: 200, h: 24, page: 1 } }
}

const INIT_FIELDS: EditorField[] = [makeField('field_1'), makeField('field_2')]

/** params の本体注入分はテスト用 no-op / 固定値で埋め、hook 単体の挙動に集中する。 */
function setup() {
  const hook = renderHook(() =>
    useFieldLayerEditor({
      templateId: 't-1',
      pageSizes: PAGE_SIZES,
      setSelectionGeom: () => {},
      getFieldsVersion: () => 'v0',
      setFieldsVersion: () => {},
      setBodyErrorMsg: () => {},
    }),
  )
  // init で fields/snapshot を確定（初回ロード effect 相当）。
  act(() =>
    hook.result.current.init(INIT_FIELDS, JSON.stringify(INIT_FIELDS)),
  )
  return hook
}

describe('useFieldLayerEditor 結合テスト', () => {
  describe('undo coalesce', () => {
    it('nudge 600ms 内 3 連打 → undo 1 回で 3 連打前に戻る', () => {
      const { result } = setup()
      act(() => result.current.setSelectedName('field_1'))

      // 同一 name の nudge を連続 3 回（同一フレームで Date.now が進まず 600ms 内扱い）。
      act(() => result.current.applyNudge('move-right'))
      act(() => result.current.applyNudge('move-right'))
      act(() => result.current.applyNudge('move-right'))

      // x は 50 → 53（1pt × 3）に進む。
      const moved = result.current.fields.find((f) => f.name === 'field_1')
      expect(moved?.bbox.x).toBe(53)
      // coalesce で undoStack は 1 段だけ。
      expect(result.current.canUndo).toBe(true)

      act(() => result.current.handleUndo())
      // 1 回の undo で 3 連打前（x=50）に戻る。
      const back = result.current.fields.find((f) => f.name === 'field_1')
      expect(back?.bbox.x).toBe(50)
      expect(result.current.canUndo).toBe(false)
    })

    it('nudge → 別 name の nudge は連鎖が切れて undo で 1 段ずつ戻る', () => {
      const { result } = setup()
      act(() => result.current.setSelectedName('field_1'))
      act(() => result.current.applyNudge('move-right'))
      // 別 field に切り替えて nudge → coalesce 連鎖が切れる。
      act(() => result.current.setSelectedName('field_2'))
      act(() => result.current.applyNudge('move-right'))

      expect(
        result.current.fields.find((f) => f.name === 'field_1')?.bbox.x,
      ).toBe(51)
      expect(
        result.current.fields.find((f) => f.name === 'field_2')?.bbox.x,
      ).toBe(51)

      // 1 回目の undo で field_2 の nudge だけ戻る。
      act(() => result.current.handleUndo())
      expect(
        result.current.fields.find((f) => f.name === 'field_2')?.bbox.x,
      ).toBe(50)
      expect(
        result.current.fields.find((f) => f.name === 'field_1')?.bbox.x,
      ).toBe(51)
      // 2 回目の undo で field_1 の nudge も戻る。
      act(() => result.current.handleUndo())
      expect(
        result.current.fields.find((f) => f.name === 'field_1')?.bbox.x,
      ).toBe(50)
    })
  })

  describe('dragPreSnapshot', () => {
    it('ドラッグ開始 → 変化なし確定（changed=false）→ undoStack が増えない', () => {
      const { result } = setup()
      expect(result.current.canUndo).toBe(false)

      act(() => result.current.handleFieldDragStart('field_1'))
      act(() => result.current.handleFieldDragCommit('field_1', false))
      // クリックのみ＝積まない。
      expect(result.current.canUndo).toBe(false)
    })

    it('ドラッグ確定（changed=true）→ undoStack +1・undo でドラッグ前に戻る', () => {
      const { result } = setup()

      act(() => result.current.handleFieldDragStart('field_1'))
      // pointermove 相当の bbox 変更を適用（applyBbox）。
      act(() =>
        result.current.applyBbox('field_1', {
          x: 120,
          y: 100,
          w: 200,
          h: 24,
          page: 1,
        }),
      )
      // pointerup 確定（changed=true）。退避していた snapshot を push する。
      act(() => result.current.handleFieldDragCommit('field_1', true))

      expect(
        result.current.fields.find((f) => f.name === 'field_1')?.bbox.x,
      ).toBe(120)
      // undoStack +1。
      expect(result.current.canUndo).toBe(true)

      // undo でドラッグ前（x=50）に戻る。
      act(() => result.current.handleUndo())
      expect(
        result.current.fields.find((f) => f.name === 'field_1')?.bbox.x,
      ).toBe(50)
    })
  })

  describe('dirty', () => {
    it('init 直後は dirty=false、fields 変更で true', () => {
      const { result } = setup()
      expect(result.current.dirty).toBe(false)
      act(() =>
        result.current.applyBbox('field_1', {
          x: 80,
          y: 100,
          w: 200,
          h: 24,
          page: 1,
        }),
      )
      expect(result.current.dirty).toBe(true)
    })
  })
})
