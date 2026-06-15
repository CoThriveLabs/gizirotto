'use client'

import { useState } from 'react'
import Link from 'next/link'
import { createSupabaseBrowserClient } from '@/lib/supabase/client'
import { humanizeErrorCode } from '@/lib/errors/user-message'

function ForgotPasswordForm() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const origin = window.location.origin
      const supabase = createSupabaseBrowserClient()
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${origin}/reset-password`,
      })
      if (error) throw error
      setSent(true)
    } catch (err) {
      setError(humanizeErrorCode(err instanceof Error ? err.message : null).message)
    } finally {
      setLoading(false)
    }
  }

  if (sent) {
    return (
      <main className="min-h-screen flex items-center justify-center px-4">
        <div className="max-w-md w-full bg-white border border-gizirotto-blue-200 rounded-lg p-6 text-center space-y-3">
          <h1 className="text-xl font-serif text-gizirotto-blue-900">メールを送りました</h1>
          <p className="text-sm text-gray-700">
            {email} 宛にパスワード再設定用のリンクをお送りしました。メールのリンクから新しいパスワードを設定してください。
          </p>
          <p className="text-sm">
            <Link href="/login" className="text-gizirotto-blue-700 hover:underline">
              ログイン画面に戻る
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
        <h1 className="text-xl font-serif text-gizirotto-blue-900">パスワードの再設定</h1>

        <p className="text-sm text-gray-600">
          ご登録のメールアドレスに、パスワード再設定用のリンクをお送りします。
        </p>

        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          className="w-full border border-gray-300 rounded px-3 py-2 text-base"
        />

        {error && <p className="text-red-600 text-sm whitespace-pre-line">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-gizirotto-blue-500 hover:bg-gizirotto-blue-700 text-white font-medium py-2 rounded disabled:opacity-50"
        >
          {loading ? '送信中…' : '再設定リンクを送る'}
        </button>

        <p className="text-center text-sm">
          <Link href="/login" className="text-gizirotto-blue-700 hover:underline">
            ログイン画面に戻る
          </Link>
        </p>
      </form>
    </main>
  )
}

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />
}
