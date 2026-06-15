'use client'

/**
 * UnsavedChangesModal — 未保存変更の離脱ガード共通モーダル。
 *
 * 設計書: docs/designs/unsaved_changes_modal_design_2026-06-14.md
 *
 * bbox-editor / AdjustView の両画面で使う制御コンポーネント。表示制御 (open) /
 * 保存 / 破棄 / キャンセル / saving / error はすべて props 注入。router は内部に持たない
 * （遷移責任は呼出側）。
 *
 * a11y:
 *   - role="dialog" aria-modal="true" aria-labelledby
 *   - Esc キー閉じ (saving 中は無視)
 *   - マウント時にキャンセルボタンへ自動 focus (破壊操作回避の安全側)
 *   - 背景クリック閉じ (saving 中は無視・内側 clickは stopPropagation)
 *   - 全ボタン disabled={saving} で多重操作防止
 *   - focus trap は v1 未実装 (現行 bbox-editor も未実装・スコープ膨張回避)
 */

import { useEffect, useRef } from 'react'

export interface UnsavedChangesModalProps {
  /** モーダル表示制御。false なら DOM 描画しない (null return)。 */
  open: boolean
  /** ヘッダ見出し。デフォルト「保存していない変更があります」。 */
  title?: string
  /** 説明文 (本文)。デフォルト「移動する前に、編集した内容を保存しますか？」。 */
  description?: string
  /**
   * 保存処理。await で完了を待つ。成功時に呼出側で onCancel を呼んで閉じるか、
   * 自動的に画面遷移するかは呼出側責任 (モーダル自体は閉じない・router を持たない)。
   * 失敗時は呼出側で error state を更新して再表示する。
   */
  onSave: () => void | Promise<void>
  /** 破棄。即座に遷移するなど。モーダル自体は閉じない (呼出側で open=false にする)。 */
  onDiscard: () => void
  /** キャンセル (モーダルを閉じる)。背景クリック / Esc / キャンセルボタンから呼ばれる。 */
  onCancel: () => void
  /** 保存中 (3 ボタンを disable + 保存ボタン文言切替)。 */
  saving?: boolean
  /** 保存失敗メッセージ (赤背景で表示)。null で非表示。 */
  error?: string | null
  /** 「保存して移動」ボタン文言。デフォルト「保存して移動」。 */
  saveLabel?: string
  /** 保存中文言。デフォルト「保存しています…」。 */
  savingLabel?: string
  /** 「保存せず移動」ボタン文言。デフォルト「保存せず移動」。 */
  discardLabel?: string
  /** キャンセルボタン文言。デフォルト「キャンセル」。 */
  cancelLabel?: string
}

const TITLE_ID = 'unsaved-changes-modal-title'

export function UnsavedChangesModal({
  open,
  title = '保存していない変更があります',
  description = '移動する前に、編集した内容を保存しますか？',
  onSave,
  onDiscard,
  onCancel,
  saving = false,
  error = null,
  saveLabel = '保存して移動',
  savingLabel = '保存しています…',
  discardLabel = '保存せず移動',
  cancelLabel = 'キャンセル',
}: UnsavedChangesModalProps) {
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)

  // Esc キー閉じ (saving 中は無視)。
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (saving) return
      onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, saving, onCancel])

  // マウント時にキャンセルボタンへ初期 focus (破壊操作回避の安全側)。
  useEffect(() => {
    if (!open) return
    cancelButtonRef.current?.focus()
  }, [open])

  if (!open) return null

  function handleOverlayClick() {
    if (saving) return
    onCancel()
  }

  function handlePanelClick(e: React.MouseEvent) {
    e.stopPropagation()
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={TITLE_ID}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4"
      onClick={handleOverlayClick}
    >
      <div
        className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl"
        onClick={handlePanelClick}
        aria-busy={saving}
      >
        <h3 id={TITLE_ID} className="text-base font-medium text-gray-900">
          {title}
        </h3>
        <p className="mt-2 text-sm text-gray-600">{description}</p>
        {error && (
          <p className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
            {error}
          </p>
        )}
        <div className="mt-5 flex flex-col gap-2">
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={saving}
            className="w-full rounded bg-gizirotto-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-gizirotto-blue-700 disabled:opacity-60"
          >
            {saving ? savingLabel : saveLabel}
          </button>
          <button
            type="button"
            onClick={onDiscard}
            disabled={saving}
            className="w-full rounded border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-60"
          >
            {discardLabel}
          </button>
          <button
            type="button"
            ref={cancelButtonRef}
            onClick={onCancel}
            disabled={saving}
            className="w-full rounded px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-60"
          >
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
