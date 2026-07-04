'use client'

import { useState } from 'react'
import { PromoteToAdminModal } from './PromoteToAdminModal'

interface Props {
  memberId: string
  displayName: string
  currentRole: string
  myRole: string
}

/**
 * 他メンバーカードに表示する「管理者に昇格」ボタン。
 * 自分が admin かつ対象が member のときのみ表示する。
 */
export function PromoteToAdminButton({
  memberId,
  displayName,
  currentRole,
  myRole,
}: Props) {
  const [open, setOpen] = useState(false)

  if (myRole !== 'admin') return null
  if (currentRole === 'admin') return null

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="text-xs bg-gizirotto-blue-500 hover:bg-gizirotto-blue-700 text-white px-3 py-1 rounded"
      >
        管理者に昇格
      </button>
      {open && (
        <PromoteToAdminModal
          memberId={memberId}
          displayName={displayName}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
