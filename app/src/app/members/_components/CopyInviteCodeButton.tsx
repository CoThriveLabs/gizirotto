'use client'

import { useState } from 'react'

export function CopyInviteCodeButton({
  code,
  url,
}: {
  code: string
  url: string
}) {
  const [copied, setCopied] = useState<'code' | 'url' | null>(null)

  async function copy(value: string, kind: 'code' | 'url') {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(kind)
      setTimeout(() => setCopied(null), 2000)
    } catch {
      // ignore
    }
  }

  return (
    <div className="flex gap-2">
      <button
        type="button"
        onClick={() => copy(code, 'code')}
        className="text-xs bg-gizirotto-blue-500 hover:bg-gizirotto-blue-700 text-white px-3 py-2 rounded whitespace-nowrap"
      >
        {copied === 'code' ? 'コピーしました' : 'コピー'}
      </button>
      <button
        type="button"
        onClick={() => copy(url, 'url')}
        className="text-xs border border-gizirotto-blue-500 text-gizirotto-blue-700 hover:bg-gizirotto-blue-50 px-3 py-2 rounded whitespace-nowrap"
      >
        {copied === 'url' ? 'URL コピー済' : 'URL'}
      </button>
    </div>
  )
}
