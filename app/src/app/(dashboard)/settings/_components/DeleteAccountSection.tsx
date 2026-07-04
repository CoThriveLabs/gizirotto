'use client'

import { useState } from 'react'
import { DeleteAccountModal } from './DeleteAccountModal'

/**
 * 設定画面の「危険操作」セクション。
 * クリックで DeleteAccountModal を開く。実削除は Server Action 経由。
 */
export function DeleteAccountSection() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="bg-red-600 hover:bg-red-700 text-white font-medium px-4 py-2 rounded"
      >
        アカウントを削除する
      </button>
      {open && <DeleteAccountModal onClose={() => setOpen(false)} />}
    </>
  )
}
