'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { DeleteTemplateModal } from '../_components/DeleteTemplateModal'

export default function DeleteButton({
  templateId,
  templateName,
}: {
  templateId: string
  templateName: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-sm border border-red-300 text-red-700 hover:bg-red-50 px-3 py-1.5 rounded"
      >
        削除
      </button>
      <DeleteTemplateModal
        templateId={templateId}
        templateName={templateName}
        open={open}
        onClose={() => setOpen(false)}
        onDeleted={() => router.push('/templates')}
      />
    </div>
  )
}
