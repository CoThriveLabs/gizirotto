'use client'

import { PencilIcon } from './PencilIcon'

/**
 * 「項目名を編集」行（C-1）。
 * 選択中 field の現 label を表示し、鉛筆アイコンのボタンでインライン入力（LabelInput）を開く。
 * label 空（仮置き前）でも「（未設定）」を出して常に編集導線を確保する。
 */
export function RenameLabelRow({
  label,
  onStartRename,
  small = false,
}: {
  label: string
  onStartRename: () => void
  small?: boolean
}) {
  const shown = label.trim() === '' ? '（未設定）' : label
  return (
    <div className="mb-2 pb-2 border-b border-gray-100 flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <span className="block text-xs text-gray-500">項目名</span>
        <span className="block text-sm text-gray-800 truncate" title={shown}>
          {shown}
        </span>
      </div>
      <button
        type="button"
        onClick={onStartRename}
        aria-label="項目名を編集"
        title="項目名を編集"
        className={
          'flex items-center gap-1 shrink-0 rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 px-2 ' +
          (small ? 'h-8 text-xs' : 'h-9 text-sm')
        }
      >
        <PencilIcon />
        <span className="hidden sm:inline">編集</span>
      </button>
    </div>
  )
}
