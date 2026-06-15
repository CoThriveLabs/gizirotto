'use client'

import { useState } from 'react'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'
import { PasswordInput } from '@/components/PasswordInput'
import { humanizeErrorCode } from '@/lib/errors/user-message'

const MIN_LENGTH = 8

export function PasswordSettingsForm() {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSuccess(false)

    if (password.length < MIN_LENGTH) {
      setError(`パスワードは ${MIN_LENGTH} 文字以上で入力してください。`)
      return
    }
    if (password !== confirm) {
      setError('2 つのパスワードが一致しません。')
      return
    }

    setSubmitting(true)
    try {
      const supabase = createSupabaseBrowserClient()
      const { error } = await supabase.auth.updateUser({ password })
      if (error) throw error
      setSuccess(true)
      setPassword('')
      setConfirm('')
    } catch (err) {
      // Supabase の生英文（"New password should be different…" 等）を UI に出さず日本語化。
      setError(humanizeErrorCode(err instanceof Error ? err.message : null).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label htmlFor="new-password" className="block text-sm text-gray-700 mb-1">
          新しいパスワード
        </label>
        <PasswordInput
          id="new-password"
          required
          minLength={MIN_LENGTH}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <div>
        <label htmlFor="confirm-password" className="block text-sm text-gray-700 mb-1">
          確認のためもう一度
        </label>
        <PasswordInput
          id="confirm-password"
          required
          minLength={MIN_LENGTH}
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </div>

      {error && <p className="text-red-600 text-sm">{error}</p>}
      {success && (
        <p className="text-gizirotto-blue-700 text-sm">
          パスワードを設定しました。次回から「パスワード」タブでログインできます。
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="bg-gizirotto-blue-500 hover:bg-gizirotto-blue-700 text-white font-medium px-4 py-2 rounded disabled:opacity-50"
      >
        {submitting ? '保存中…' : 'パスワードを保存'}
      </button>
    </form>
  )
}
