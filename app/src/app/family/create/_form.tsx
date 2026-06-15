'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createFamily } from '@/server/families'
import { humanizeErrorCode } from '@/lib/errors/user-message'
import { FamilyClaimNotReflectedDialog } from '../_components/FamilyClaimNotReflectedDialog'

export function CreateFamilyForm() {
  const router = useRouter()
  const [familyName, setFamilyName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [showFallback, setShowFallback] = useState(false)
  const [pending, startTransition] = useTransition()

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    startTransition(async () => {
      try {
        const result = await createFamily({ familyName, displayName })
        if (result.ok) {
          router.replace('/')
          router.refresh()
        } else if (result.code === 'FAMILY_CLAIM_NOT_REFLECTED') {
          setShowFallback(true)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'UNKNOWN_ERROR')
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
          <label htmlFor="family-name" className="block text-sm text-gray-700">
            家族名
          </label>
          <input
            id="family-name"
            type="text"
            required
            maxLength={40}
            value={familyName}
            onChange={(e) => setFamilyName(e.target.value)}
            placeholder="例: 山田家"
            className="w-full border border-gray-300 rounded px-3 py-2 text-base"
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
            placeholder="例: お父さん"
            className="w-full border border-gray-300 rounded px-3 py-2 text-base"
          />
        </div>
        {error && (
          <p className="text-red-600 text-sm">{humanizeErrorCode(error).message}</p>
        )}
        <button
          type="submit"
          disabled={pending}
          className="w-full bg-gizirotto-blue-500 hover:bg-gizirotto-blue-700 text-white font-medium py-2 rounded disabled:opacity-50"
        >
          {pending ? '作成中…' : '家族を作成'}
        </button>
      </form>
      {showFallback && <FamilyClaimNotReflectedDialog />}
    </>
  )
}
