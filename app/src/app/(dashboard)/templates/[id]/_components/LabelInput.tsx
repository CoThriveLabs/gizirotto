'use client'

import { useEffect, useRef } from 'react'

/** label の最大文字数（サーバ LABEL_MAX と一致）。入力時点で制限。 */
const LABEL_MAX = 40

/**
 * label インライン入力欄（グループB Phase B-3）。
 * 枠生成直後に選択枠近傍へ出す。必須・max40（入力時点で制限）・空確定なら親が「項目N」仮置き。
 * Enter / blur で確定（onCommit）。マウント時に自動フォーカス。
 */
export function LabelInput({
  value,
  onChange,
  onCommit,
}: {
  value: string
  onChange: (value: string) => void
  onCommit: () => void
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  return (
    <div className="mb-2 pb-2 border-b border-gray-100">
      <label className="block text-xs text-gray-600 mb-1">項目名</label>
      <input
        ref={inputRef}
        type="text"
        value={value}
        maxLength={LABEL_MAX}
        placeholder="例: 部署名"
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onCommit()
          }
        }}
        className="w-full sm:w-56 h-11 px-3 rounded border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-gizirotto-blue-300"
      />
    </div>
  )
}
