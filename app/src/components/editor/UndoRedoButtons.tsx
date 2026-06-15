'use client'

/**
 * 戻る / 進む ボタン群（Phase 4 共通化）。
 *
 * bbox-editor-client.tsx L2272-2308 / AdjustView.tsx L2478-2515 は完全一致。
 * 差分ゼロのため props 化不要。
 */
import { UndoArrow } from './UndoArrow'

export function UndoRedoButtons({
  onUndo,
  onRedo,
  canUndo,
  canRedo,
}: {
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={onUndo}
        disabled={!canUndo}
        title="戻る（Ctrl+Z）"
        aria-label="戻る"
        className="flex items-center gap-1 bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 font-medium px-3 py-2 rounded text-sm disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <UndoArrow dir="back" />
        <span className="hidden sm:inline">戻る</span>
      </button>
      <button
        type="button"
        onClick={onRedo}
        disabled={!canRedo}
        title="進む（Ctrl+Shift+Z）"
        aria-label="進む"
        className="flex items-center gap-1 bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 font-medium px-3 py-2 rounded text-sm disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <UndoArrow dir="forward" />
        <span className="hidden sm:inline">進む</span>
      </button>
    </div>
  )
}
