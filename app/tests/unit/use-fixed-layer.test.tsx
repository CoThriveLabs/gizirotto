/**
 * useFixedLayer フックの結合テスト（Phase 7 S4・固定テキストレイヤ抽出の関所）。
 *
 * 検証する不変条件（hook が useLayerEditor を正しく配線していること）:
 *   - undo: applyNudge 後に undo で元位置に戻る
 *   - redo: undo 後に redo で進んだ位置に戻る
 *   - dirty: init 直後は false・applyNudge で true
 *   - drag: changed=false → undoStack 増えない / changed=true → undoStack +1
 *   - value coalesce: 1 秒以内の連続入力は 1 ステップ（undo 1 回で元に戻る）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useFixedLayer } from '@/hooks/editor/useFixedLayer'
import type { EditorField } from '@/app/(dashboard)/templates/[id]/bbox-pane'
import type { FixedTextMeta } from '@/lib/pdf-output/fixedtext-adapter'
import type { PageMeta } from '@/lib/pdf-output/bbox-coords'

const PAGE_SIZES: PageMeta[] = [
  { page: 1, widthPt: 595, heightPt: 842, pixelWidth: 595, pixelHeight: 842 },
]

function makeField(name: string): EditorField {
  return { name, label: '', bbox: { x: 50, y: 100, w: 200, h: 30, page: 1 } }
}

function makeMeta(): Map<string, FixedTextMeta> {
  return new Map([['ft_1', { value: '', font: { family: 'NotoSansJP', size: 12 } }]])
}

const INIT_FIELDS: EditorField[] = [makeField('ft_1')]

/** params の本体注入分はテスト用 no-op で埋め、hook 単体の挙動に集中する。 */
function setup() {
  const hook = renderHook(() =>
    useFixedLayer({
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

describe('useFixedLayer 結合テスト', () => {
  describe('undo', () => {
    it('applyNudge 後に undo で元位置に戻る', () => {
      const { result } = setup()
      act(() => result.current.setSelectedName('ft_1'))
      act(() => result.current.applyNudge('move-right'))

      const moved = result.current.fields.find((f) => f.name === 'ft_1')
      expect(moved?.bbox.x).toBe(51)
      expect(result.current.canUndo).toBe(true)

      act(() => result.current.undo())
      const back = result.current.fields.find((f) => f.name === 'ft_1')
      expect(back?.bbox.x).toBe(50)
      expect(result.current.canUndo).toBe(false)
    })
  })

  describe('redo', () => {
    it('undo 後に redo で進んだ位置に戻る', () => {
      const { result } = setup()
      act(() => result.current.setSelectedName('ft_1'))
      act(() => result.current.applyNudge('move-right'))
      act(() => result.current.undo())

      expect(result.current.fields.find((f) => f.name === 'ft_1')?.bbox.x).toBe(50)
      expect(result.current.canRedo).toBe(true)

      act(() => result.current.redo())
      expect(result.current.fields.find((f) => f.name === 'ft_1')?.bbox.x).toBe(51)
      expect(result.current.canRedo).toBe(false)
    })
  })

  describe('dirty', () => {
    it('init 直後は dirty=false、applyNudge で true', () => {
      const { result } = setup()
      expect(result.current.dirty).toBe(false)
      act(() => result.current.setSelectedName('ft_1'))
      act(() => result.current.applyNudge('move-right'))
      expect(result.current.dirty).toBe(true)
    })
  })

  describe('drag', () => {
    it('ドラッグ開始 → 変化なし確定（changed=false）→ undoStack が増えない', () => {
      const { result } = setup()
      expect(result.current.canUndo).toBe(false)

      act(() => result.current.onDragStart())
      act(() => result.current.onDragCommit('ft_1', false))
      expect(result.current.canUndo).toBe(false)
    })

    it('ドラッグ確定（changed=true）→ undoStack +1・undo でドラッグ前に戻る', () => {
      const { result } = setup()

      act(() => result.current.onDragStart())
      act(() =>
        result.current.applyBbox('ft_1', {
          x: 120,
          y: 100,
          w: 200,
          h: 30,
          page: 1,
        }),
      )
      act(() => result.current.onDragCommit('ft_1', true))

      expect(result.current.fields.find((f) => f.name === 'ft_1')?.bbox.x).toBe(120)
      expect(result.current.canUndo).toBe(true)

      act(() => result.current.undo())
      expect(result.current.fields.find((f) => f.name === 'ft_1')?.bbox.x).toBe(50)
    })
  })

  describe('value coalesce（§3-3）', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('1 秒以内の連続入力は 1 undo ステップに coalesce される', () => {
      const { result } = setup()

      // 1 打目: undo push → undoStack=[init]、last.at=0。
      act(() => result.current.fixedValueChange('ft_1', 'a'))
      expect(result.current.canUndo).toBe(true)

      // 0.5 秒後の 2 打目: now - last.at = 500 < 1000 → coalesce（push しない）、last.at=500。
      act(() => vi.advanceTimersByTime(500))
      act(() => result.current.fixedValueChange('ft_1', 'ab'))

      // さらに 0.5 秒後の 3 打目: now - last.at = 500 < 1000 → coalesce（push しない）。
      // undoStack は 1 ステップ（init 状態）のまま。
      act(() => vi.advanceTimersByTime(500))
      act(() => result.current.fixedValueChange('ft_1', 'abc'))

      // coalesce のため undoStack は 1 ステップのみ。undo 1 回で init 状態（value=''）に戻る。
      act(() => result.current.undo())
      expect(result.current.meta.get('ft_1')?.value).toBe('')
      expect(result.current.canUndo).toBe(false)
    })

    it('1 秒以上経過した同一 name 入力は別 undo ステップになる', () => {
      const { result } = setup()

      // 1 打目。
      act(() => result.current.fixedValueChange('ft_1', 'a'))
      expect(result.current.canUndo).toBe(true)

      // 1001ms 後の 2 打目: 別ステップとして push。
      act(() => vi.advanceTimersByTime(1001))
      act(() => result.current.fixedValueChange('ft_1', 'ab'))

      // undo 1 回目: 2 打目前の状態（value='a'）に戻る。
      act(() => result.current.undo())
      expect(result.current.meta.get('ft_1')?.value).toBe('a')

      // undo 2 回目: 1 打目前の状態（value=''）に戻る。
      act(() => result.current.undo())
      expect(result.current.meta.get('ft_1')?.value).toBe('')
      expect(result.current.canUndo).toBe(false)
    })
  })
})
