'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import type { PageMeta, BoxState, PdfBoxPt } from './whiteout-modal-types'

interface PagePaneProps {
  meta: PageMeta
  imageUrl: string | null
  boxes: BoxState[]
  onAddBox: (bbox: PdfBoxPt) => void
  onRemoveBox: (id: string) => void
  onToggleSuggestion: (id: string) => void
}

export function PagePane({
  meta,
  imageUrl,
  boxes,
  onAddBox,
  onRemoveBox,
  onToggleSuggestion,
}: PagePaneProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const [drag, setDrag] = useState<{
    startX: number
    startY: number
    curX: number
    curY: number
  } | null>(null)

  // 画面上の表示倍率: 親要素幅にフィット（最大 800px）
  const displayWidth = Math.min(meta.pixelWidth, 800)
  const displayScale = displayWidth / meta.pixelWidth
  const displayHeight = meta.pixelHeight * displayScale

  // px (display) → pt 変換係数
  const pxToPtX = useMemo(
    () => meta.widthPt / meta.pixelWidth,
    [meta.widthPt, meta.pixelWidth],
  )
  const pxToPtY = useMemo(
    () => meta.heightPt / meta.pixelHeight,
    [meta.heightPt, meta.pixelHeight],
  )
  // pt → px (display) は逆 + displayScale 込み（描画用）
  const ptToDispX = useCallback(
    (xPt: number) => (xPt / meta.widthPt) * displayWidth,
    [meta.widthPt, displayWidth],
  )
  const ptToDispY = useCallback(
    (yPt: number) => (yPt / meta.heightPt) * displayHeight,
    [meta.heightPt, displayHeight],
  )

  function clientToDisplay(
    e: React.PointerEvent<HTMLDivElement>,
  ): { x: number; y: number } | null {
    const el = wrapperRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(displayWidth, e.clientX - rect.left)),
      y: Math.max(0, Math.min(displayHeight, e.clientY - rect.top)),
    }
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    // 矩形 (data-box) の上ではドラッグ開始しない
    if (target.closest('[data-box]')) return
    const p = clientToDisplay(e)
    if (!p) return
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    setDrag({ startX: p.x, startY: p.y, curX: p.x, curY: p.y })
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!drag) return
    const p = clientToDisplay(e)
    if (!p) return
    setDrag({ ...drag, curX: p.x, curY: p.y })
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!drag) return
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      // ignore
    }
    const x1 = Math.min(drag.startX, drag.curX)
    const y1 = Math.min(drag.startY, drag.curY)
    const x2 = Math.max(drag.startX, drag.curX)
    const y2 = Math.max(drag.startY, drag.curY)
    setDrag(null)
    const wDisp = x2 - x1
    const hDisp = y2 - y1
    if (wDisp < 4 || hDisp < 4) return // 誤クリック扱い
    // display px → 元画像 px → pt
    const xImg = x1 / displayScale
    const yImg = y1 / displayScale
    const wImg = wDisp / displayScale
    const hImg = hDisp / displayScale
    onAddBox({
      x: xImg * pxToPtX,
      y: yImg * pxToPtY,
      w: wImg * pxToPtX,
      h: hImg * pxToPtY,
    })
  }

  return (
    <div>
      <p className="text-xs text-gray-500 mb-1">ページ {meta.page}</p>
      <div
        ref={wrapperRef}
        className="relative select-none border border-gray-300 bg-gray-100 touch-none"
        style={{ width: displayWidth, height: displayHeight }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl}
            alt={`ページ ${meta.page}`}
            width={displayWidth}
            height={displayHeight}
            draggable={false}
            className="absolute inset-0 w-full h-full pointer-events-none"
          />
        )}

        {boxes.map((b) => {
          const x = ptToDispX(b.bbox.x)
          const y = ptToDispY(b.bbox.y)
          const w = ptToDispX(b.bbox.x + b.bbox.w) - x
          const h = ptToDispY(b.bbox.y + b.bbox.h) - y
          const isSuggestion = b.source === 'auto_suggestion'
          const dismissed = b.dismissed ?? false
          // 白塗り枠を「灰色30%枠」にし記入欄(青)と視覚差別化。
          //   ※当初は白30%枠だったが、白い紙背景に埋もれて見えない実機FBにより灰色系へ変更。
          //   - auto候補（採用中）: 灰色30%破線（border-gray-500 border-dashed bg-gray-400/30）＝候補=未確定の含意
          //   - manual（確定）   : 灰色30%実線（border-gray-600 bg-gray-400/30）
          //   - dismissed（却下） : 塗らない含意なので従来どおり薄グレー破線・透明（塗り色を付けない）
          // 🚨 個人情報死守: この 30%透過は「編集UI上の表示」だけ。実際の焼き込み（出力DL PDF）は
          //    従来どおり estimatedBgColor の不透明白で対象領域を完全被覆する（透過は出力に出ない）。
          const boxClass = isSuggestion
            ? dismissed
              ? 'border-gray-400 border-dashed bg-transparent'
              : 'border-gray-500 border-dashed bg-gray-400/30'
            : 'border-gray-600 bg-gray-400/30'
          return (
            <div
              key={b.id}
              data-box
              className={'absolute border ' + boxClass}
              style={{
                left: x,
                top: y,
                width: Math.max(2, w),
                height: Math.max(2, h),
              }}
              onClick={(e) => {
                e.stopPropagation()
                if (isSuggestion) onToggleSuggestion(b.id)
              }}
              title={
                isSuggestion
                  ? dismissed
                    ? 'クリックで採用'
                    : 'クリックで採用解除'
                  : '右上の × で削除'
              }
            >
              {!isSuggestion && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemoveBox(b.id)
                  }}
                  className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-red-500 text-white text-xs leading-none"
                  aria-label="この矩形を削除"
                >
                  ×
                </button>
              )}
            </div>
          )
        })}

        {drag && (
          <div
            className="absolute border border-gray-700 bg-white/60 pointer-events-none"
            style={{
              left: Math.min(drag.startX, drag.curX),
              top: Math.min(drag.startY, drag.curY),
              width: Math.abs(drag.curX - drag.startX),
              height: Math.abs(drag.curY - drag.startY),
            }}
          />
        )}
      </div>
    </div>
  )
}
