'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'
import { PasswordInput } from '@/components/PasswordInput'
import { humanizeErrorCode } from '@/lib/errors/user-message'

const MIN_LENGTH = 8

function ResetPasswordForm() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [hasSession, setHasSession] = useState<boolean | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    const supabase = createSupabaseBrowserClient()
    supabase.auth.getSession().then(({ data }) => {
      setHasSession(!!data.session)
    })
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

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
      setTimeout(() => {
        router.push('/login')
        router.refresh()
      }, 1500)
    } catch (err) {
      setError(humanizeErrorCode(err instanceof Error ? err.message : null).message)
    } finally {
      setSubmitting(false)
    }
  }

  if (hasSession === false) {
    return (
      <main className="min-h-screen flex items-center justify-center px-4">
        <div className="max-w-md w-full bg-white border border-gizirotto-blue-200 rounded-lg p-6 text-center space-y-3">
          <h1 className="text-xl font-serif text-gizirotto-blue-900">リンクが無効です</h1>
          <p className="text-sm text-gray-700">
            パスワード再設定リンクの有効期限が切れているか、すでに使用済みの可能性があります。お手数ですが、もう一度お試しください。
          </p>
          <p className="text-sm">
            <Link href="/forgot-password" className="text-gizirotto-blue-700 hover:underline">
              再設定リンクを送り直す
            </Link>
          </p>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <form
        onSubmit={handleSubmit}
        className="max-w-md w-full bg-white border border-gizirotto-blue-200 rounded-lg p-6 space-y-4"
      >
        <h1 className="text-xl font-serif text-gizirotto-blue-900">新しいパスワードの設定</h1>

        <p className="text-sm text-gray-600">
          新しいパスワードを入力してください。{MIN_LENGTH} 文字以上で設定できます。
        </p>

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

        {error && <p className="text-red-600 text-sm whitespace-pre-line">{error}</p>}
        {success && (
          <p className="text-gizirotto-blue-700 text-sm">
            パスワードを再設定しました。ログイン画面に移動します…
          </p>
        )}

        <button
          type="submit"
          disabled={submitting || success}
          className="w-full bg-gizirotto-blue-500 hover:bg-gizirotto-blue-700 text-white font-medium py-2 rounded disabled:opacity-50"
        >
          {submitting ? '保存中…' : 'パスワードを再設定する'}
        </button>
      </form>
    </main>
  )
}

export default function ResetPasswordPage() {
  return <ResetPasswordForm />
}
