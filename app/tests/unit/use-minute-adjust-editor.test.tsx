/**
 * useMinuteAdjustEditor フックの結合テスト（Phase 7 S2 関所）。
 *
 * 検証する不変条件:
 *   - undo coalesce: nudge 600ms 内連打 / value 1 秒内連続が 1 ステップに畳まれる
 *   - dragPreSnapshot: クリックのみ（changed=false）は undoStack を増やさない
 *   - drag 確定: changed=true で undoStack +1・isDragging が false に戻る
 *   - editorDirty: 値変更で true・初期状態で false
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useMinuteAdjustEditor } from '@/hooks/editor/useMinuteAdjustEditor'
import type { TemplateFieldDef } from '@/app/(dashboard)/minutes/[id]/adjust/AdjustView'
import { PdfFieldSchemaZ, type PdfField } from '@/lib/ai/schemas/pdf-field-schema'
import type { PageMeta } from '@/lib/pdf-output/bbox-coords'

function makeTemplateField(name: string, label: string): TemplateFieldDef {
  return { name, label, bbox: { x: 50, y: 100, w: 200, h: 24 }, multiline: false }
}

function makePdfField(name: string, label: string): PdfField {
  return PdfFieldSchemaZ.parse({
    name,
    label,
    type: 'text',
    bbox: { page: 1, x: 50, y: 100, w: 200, h: 24 },
    max_chars: 200,
    font: { family: 'NotoSansJP', size: 11 },
  })
}

const FIELDS: TemplateFieldDef[] = [
  makeTemplateField('a', 'A'),
  makeTemplateField('b', 'B'),
]
const PDF_FIELDS: PdfField[] = [makePdfField('a', 'A'), makePdfField('b', 'B')]
const PAGE_SIZES: PageMeta[] = [
  { page: 1, widthPt: 595, heightPt: 842, pixelWidth: 595, pixelHeight: 842 },
]

function setup(initialValues: Record<string, string> = { a: '', b: '' }) {
  const textareaRef = { current: null }
  return renderHook(() =>
    useMinuteAdjustEditor({
      minuteId: 'm-1',
      initialFields: FIELDS,
      initialValues,
      initialOverrides: {},
      pdfFields: PDF_FIELDS,
      pageSizes: PAGE_SIZES,
      // previewFont=null で bbox.h 自動連動 effect をスキップし coalesce/drag に集中する。
      previewFont: null,
      textareaRef: textareaRef as React.RefObject<HTMLTextAreaElement | null>,
    }),
  )
}

describe('useMinuteAdjustEditor 結合テスト', () => {
  beforeEach(() => {
    // hook 内 useDebouncedSelectedBackground が呼ぶ fetch をモック（テキスト 0 の背景）。
    globalThis.fetch = vi.fn(async () =>
      Promise.resolve({
        ok: true,
        json: async () => ({ signedUrl: 'https://example.com/bg.png' }),
      } as unknown as Response),
    ) as unknown as typeof fetch
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('undo coalesce', () => {
    it('nudge 600ms 内 3 連打 → undo 1 回で 3 連打前に戻る', () => {
      const { result } = setup()
      act(() => result.current.setSelected('a'))

      // 同一 name の nudge を連続 3 回（Date.now が同一フレームで進まないため 600ms 内扱い）。
      act(() => result.current.applyNudgeAction('move-right'))
      act(() => result.current.applyNudgeAction('move-right'))
      act(() => result.current.applyNudgeAction('move-right'))

      // x は 50 → 53（1pt × 3）に進む。
      expect(result.current.overrides.a?.x).toBe(53)
      // coalesce で undoStack は 1 段だけ。
      expect(result.current.canUndo).toBe(true)

      act(() => result.current.undo())
      // 1 回の undo で 3 連打前（override なし = 素 x=50 baseline）に戻る。
      expect(result.current.overrides.a?.x).toBeUndefined()
      expect(result.current.canUndo).toBe(false)
    })

    it('value 1 秒内 3 回 → undo 1 回で 3 回前に戻る', () => {
      const { result } = setup({ a: '', b: '' })
      act(() => result.current.onValueChange('a', 'x'))
      act(() => result.current.onValueChange('a', 'xy'))
      act(() => result.current.onValueChange('a', 'xyz'))

      expect(result.current.values.a).toBe('xyz')

      act(() => result.current.undo())
      // value coalesce で 1 段 → 入力前の空文字に戻る。
      expect(result.current.values.a).toBe('')
    })

    it('nudge → 別 name の nudge は連鎖が切れて undo で 1 段ずつ戻る', () => {
      const { result } = setup()
      act(() => result.current.setSelected('a'))
      act(() => result.current.applyNudgeAction('move-right'))
      // 別 field に切り替えて nudge → coalesce 連鎖が切れる。
      act(() => result.current.setSelected('b'))
      act(() => result.current.applyNudgeAction('move-right'))

      expect(result.current.overrides.a?.x).toBe(51)
      expect(result.current.overrides.b?.x).toBe(51)

      // 1 回目の undo で b の nudge だけ戻る。
      act(() => result.current.undo())
      expect(result.current.overrides.b?.x).toBeUndefined()
      expect(result.current.overrides.a?.x).toBe(51)
      // 2 回目の undo で a の nudge も戻る。
      act(() => result.current.undo())
      expect(result.current.overrides.a?.x).toBeUndefined()
    })
  })

  describe('dragPreSnapshot / isDragging', () => {
    it('ドラッグ開始 → 変化なし確定（changed=false）→ undoStack が増えない', () => {
      const { result } = setup()
      expect(result.current.canUndo).toBe(false)

      act(() => result.current.handleDragStart())
      expect(result.current.isDragging).toBe(true)

      act(() => result.current.handleDragCommit('a', false))
      // クリックのみ＝積まない。
      expect(result.current.canUndo).toBe(false)
      // 確定後 isDragging は false。
      expect(result.current.isDragging).toBe(false)
    })

    it('ドラッグ確定（changed=true）→ undoStack +1・isDragging=false・overrides に flush', () => {
      const { result } = setup()

      act(() => result.current.handleDragStart())
      // pointermove 相当の bbox 変更を RAF バッファに積む。
      act(() =>
        result.current.handleChangeBbox('a', {
          x: 120,
          y: 100,
          w: 200,
          h: 24,
          page: 1,
        }),
      )
      // pointerup 確定（changed=true）。内部で残バッファを同期 flush する。
      act(() => result.current.handleDragCommit('a', true))

      expect(result.current.isDragging).toBe(false)
      // 最終 bbox が overrides に flush されている。
      expect(result.current.overrides.a?.x).toBe(120)
      // undoStack +1。
      expect(result.current.canUndo).toBe(true)

      // undo でドラッグ前（override なし）に戻る。
      act(() => result.current.undo())
      expect(result.current.overrides.a?.x).toBeUndefined()
    })
  })

  describe('editorDirty', () => {
    it('初期状態は dirty=false、値変更で true', () => {
      const { result } = setup()
      expect(result.current.dirty).toBe(false)
      act(() => result.current.onValueChange('a', 'hello'))
      expect(result.current.dirty).toBe(true)
    })
  })
})
