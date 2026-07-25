'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { joinFamily } from '@/server/families'
import { humanizeErrorCode } from '@/lib/errors/user-message'
import { FamilyClaimNotReflectedDialog } from '../_components/FamilyClaimNotReflectedDialog'

export function JoinFamilyForm({
  initialCode,
  next,
}: {
  initialCode: string
  next: string | null
}) {
  const router = useRouter()
  const [inviteCode, setInviteCode] = useState(initialCode.toUpperCase())
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [showFallback, setShowFallback] = useState(false)
  const [pending, startTransition] = useTransition()

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    startTransition(async () => {
      try {
        const result = await joinFamily({ inviteCode, displayName })
        if (result.ok) {
          router.replace(next || '/')
          router.refresh()
        } else if (result.code === 'FAMILY_CLAIM_NOT_REFLECTED') {
          setShowFallback(true)
        }
      } catch (err) {
        const code = err instanceof Error ? err.message : 'UNKNOWN_ERROR'
        setError(humanizeErrorCode(code).message)
      }
    })
  }

  return (
    <>
      <form
        onSubmit={handleSubmit}
        className="bg-white border border-gizirotto-blue-200 rounded-lg p-6 space-y-4"
      >
        <div className="space-y-1">
          <label htmlFor="invite-code" className="block text-sm text-gray-700">
            招待コード（10 桁）
          </label>
          <input
            id="invite-code"
            type="text"
            required
            maxLength={10}
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
            placeholder="ABCDEFGHJK"
            className="w-full border border-gray-300 rounded px-3 py-2 text-base font-mono tracking-widest"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="display-name" className="block text-sm text-gray-700">
            あなたの表示名
          </label>
          <input
            id="display-name"
            type="text"
            required
            maxLength={20}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="例: お母さん"
            className="w-full border border-gray-300 rounded px-3 py-2 text-base"
          />
        </div>
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <button
          type="submit"
          disabled={pending}
          className="w-full bg-gizirotto-blue-500 hover:bg-gizirotto-blue-700 text-white font-medium py-2 rounded disabled:opacity-50"
        >
          {pending ? '参加処理中…' : '家族に参加する'}
        </button>
      </form>
      {showFallback && <FamilyClaimNotReflectedDialog />}
    </>
  )
}
