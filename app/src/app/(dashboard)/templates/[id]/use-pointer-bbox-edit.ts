'use client'

/**
 * bbox pointer 編集ロジック（bbox-pane.tsx から分離）。
 *
 * 枠の移動/リサイズドラッグの開始・追従・確定を扱う。座標計算は
 * lib/pdf-output/bbox-coords の純関数のみ使用（編集中は pt 空間で直接計算）。
 */
import { useState } from 'react'
import {
  type PageMeta,
  type BboxPt,
  type ResizeCorner,
  type FitOptions,
  dispToPtX,
  dispToPtY,
  moveBbox,
  resizeBbox,
  resizeBboxKeepAspect,
  clampResizeToPage,
} from '@/lib/pdf-output/bbox-coords'
import type { EditorField } from './bbox-pane'

export type DragState =
  | { kind: 'move'; name: string; startBbox: BboxPt; startX: number; startY: number }
  | {
      kind: 'resize'
      name: string
      corner: ResizeCorner
      startBbox: BboxPt
      startX: number
      startY: number
    }
  | null

export interface UsePointerBboxEditParams {
  meta: PageMeta
  fields: EditorField[]
  fitOpts: FitOptions
  wrapperRef: React.RefObject<HTMLDivElement | null>
  onSelect: (name: string | null) => void
  onChangeBbox: (name: string, bbox: BboxPt & { page: number }) => void
  onDragStart?: (name: string) => void
  onDragCommit?: (name: string, changed: boolean) => void
  keepAspect: boolean
}

export interface UsePointerBboxEditReturn {
  drag: DragState
  startMove: (e: React.PointerEvent, f: EditorField) => void
  startResize: (e: React.PointerEvent, f: EditorField, corner: ResizeCorner) => void
  handlePointerMove: (e: React.PointerEvent) => void
  endDrag: (e: React.PointerEvent) => void
}

export function usePointerBboxEdit({
  meta,
  fields,
  fitOpts,
  wrapperRef,
  onSelect,
  onChangeBbox,
  onDragStart,
  onDragCommit,
  keepAspect,
}: UsePointerBboxEditParams): UsePointerBboxEditReturn {
  const [drag, setDrag] = useState<DragState>(null)

  // wrapper（座標系コンテナ）は border を持たず（outline 化・§A2-2）、size=dispW/dispH ちょうど。
  // よって getBoundingClientRect の left/top は padding-box（=bbox 座標原点）と一致する。
  function clientToDisplay(e: React.PointerEvent): { x: number; y: number } | null {
    const el = wrapperRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function startMove(e: React.PointerEvent, f: EditorField) {
    if (e.button !== undefined && e.button !== 0) return
    const p = clientToDisplay(e)
    if (!p) return
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    onSelect(f.name)
    onDragStart?.(f.name) // undo: ドラッグ前 snapshot を親が push（§2-2）。
    setDrag({
      kind: 'move',
      name: f.name,
      startBbox: { ...f.bbox },
      startX: p.x,
      startY: p.y,
    })
  }

  function startResize(e: React.PointerEvent, f: EditorField, corner: ResizeCorner) {
    if (e.button !== undefined && e.button !== 0) return
    const p = clientToDisplay(e)
    if (!p) return
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    onSelect(f.name)
    onDragStart?.(f.name) // undo: ドラッグ前 snapshot を親が push（§2-2）。
    setDrag({
      kind: 'resize',
      name: f.name,
      corner,
      startBbox: { ...f.bbox },
      startX: p.x,
      startY: p.y,
    })
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!drag) return
    const p = clientToDisplay(e)
    if (!p) return
    // 表示 px の移動量 → pt の移動量（pt 空間で startBbox に適用）。
    // 描画と同じ fitOpts を使い、往復一致（±4px）を保つ（§A1 / PY1-0）。
    const dxPt = dispToPtX(meta, p.x - drag.startX, fitOpts)
    const dyPt = dispToPtY(meta, p.y - drag.startY, fitOpts)
    const f = fields.find((ff) => ff.name === drag.name)
    if (!f) return
    let next: BboxPt
    if (drag.kind === 'move') {
      // 移動: w/h 固定で x/y をページ内へ引き戻す。
      next = clampToPage(moveBbox(drag.startBbox, dxPt, dyPt))
    } else if (keepAspect) {
      // C-2 v1.5（§3-2-3）: 固定テキストは縦横比保持リサイズ。aspect は開始時 bbox の w/h。
      // ラッパが対角 anchor 固定・長辺基準・ページ端クランプ（比率保持）まで担うので clampResizeToPage は不要。
      const aspect = drag.startBbox.h > 0 ? drag.startBbox.w / drag.startBbox.h : 1
      next = resizeBboxKeepAspect(drag.startBbox, drag.corner, dxPt, dyPt, aspect, meta)
    } else {
      // リサイズ: x/y を引き戻さず、はみ出した辺だけ縮める（綱引き回避・差し戻し-3）。
      next = clampResizeToPage(
        resizeBbox(drag.startBbox, drag.corner, dxPt, dyPt),
        meta,
      )
    }
    onChangeBbox(drag.name, { ...next, page: f.bbox.page })
  }

  function endDrag(e: React.PointerEvent) {
    if (!drag) return
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      // ignore
    }
    // undo 誤push修正（実機FB）: クリックのみ（移動量0）なら bbox は不変＝push しない。
    // 確定時の bbox を startBbox と比較し、実際に変化したときだけ親へ commit(changed=true)。
    const f = fields.find((ff) => ff.name === drag.name)
    const start = drag.startBbox
    const changed =
      !!f &&
      (f.bbox.x !== start.x ||
        f.bbox.y !== start.y ||
        f.bbox.w !== start.w ||
        f.bbox.h !== start.h)
    onDragCommit?.(drag.name, changed)
    setDrag(null)
  }

  /** ドラッグ中もページ範囲内に収める（S1）。w/h は維持。 */
  function clampToPage(b: BboxPt): BboxPt {
    const x = Math.max(0, Math.min(b.x, meta.widthPt - b.w))
    const y = Math.max(0, Math.min(b.y, meta.heightPt - b.h))
    return { x, y, w: b.w, h: b.h }
  }

  return { drag, startMove, startResize, handlePointerMove, endDrag }
}
