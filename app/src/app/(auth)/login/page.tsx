'use client'

import { Suspense, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { sanitizeNextParam } from '@/lib/safe-next'
import { PasswordInput } from '@/components/PasswordInput'
import { containsJapanese, humanizeErrorCode } from '@/lib/errors/user-message'
import { TurnstileWidget } from '@/components/auth/TurnstileWidget'

const INVALID_CREDENTIALS_HINT =
  'メールアドレスかパスワードが違うようです。パスワード未設定の場合は、メール認証でログイン後に「設定」画面でパスワードを設定してください。'

type Mode = 'magic' | 'password'

function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const rawNext = searchParams.get('next')
  const [mode, setMode] = useState<Mode>('magic')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [turnstileToken, setTurnstileToken] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const origin = window.location.origin
      const nextSafe = sanitizeNextParam(rawNext, origin) ?? '/'
      // 案A: browser client 直叩きをやめ /api/auth/login にサーバ集約。
      // Turnstile token を同梱しサーバ側で siteverify する。
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          email,
          password,
          turnstileToken,
          isSignup: mode === 'magic', // 初回 magic link を signup 扱い (IP 記録対象)
          emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(nextSafe)}`,
        }),
      })
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        sent?: boolean
        error?: string
        code?: string
      }

      if (res.status === 403) {
        throw new Error(
          json.error ??
            '認証チャレンジに失敗しました。ページを再読み込みしてください',
        )
      }
      if (!res.ok) {
        // 既存の親切文を温存: INVALID_CREDENTIALS / "Invalid login credentials"
        // → パスワード未設定誘導文に置換。
        const raw = json.error ?? ''
        if (
          json.code === 'INVALID_CREDENTIALS' ||
          /invalid login credentials/i.test(raw)
        ) {
          throw new Error(INVALID_CREDENTIALS_HINT)
        }
        throw new Error(raw)
      }

      if (json.sent) {
        setSent(true)
      } else {
        router.push(nextSafe)
        router.refresh()
      }
    } catch (err) {
      // 自前の親切文（日本語）は温存。それ以外の素の英文/コードだけ日本語化する。
      const raw = err instanceof Error ? err.message : ''
      setError(containsJapanese(raw) ? raw : humanizeErrorCode(raw).message)
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
            {email} 宛にログイン用リンクをお送りしました。メールのリンクからログインしてください。
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
        <h1 className="text-xl font-serif text-gizirotto-blue-900">ログイン</h1>

        <div
          role="tablist"
          aria-label="ログイン方法"
          className="flex border border-gizirotto-blue-200 rounded overflow-hidden text-sm"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'magic'}
            onClick={() => {
              setMode('magic')
              setError(null)
            }}
            className={
              mode === 'magic'
                ? 'flex-1 bg-gizirotto-blue-500 text-white py-2'
                : 'flex-1 bg-white text-gizirotto-blue-700 py-2 hover:bg-gizirotto-blue-50'
            }
          >
            メール認証
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'password'}
            onClick={() => {
              setMode('password')
              setError(null)
            }}
            className={
              mode === 'password'
                ? 'flex-1 bg-gizirotto-blue-500 text-white py-2'
                : 'flex-1 bg-white text-gizirotto-blue-700 py-2 hover:bg-gizirotto-blue-50'
            }
          >
            パスワード
          </button>
        </div>

        <p className="text-sm text-gray-600">
          {mode === 'magic'
            ? 'メールアドレスにログイン用リンクをお送りします。'
            : 'メールアドレスとパスワードでログインします。'}
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

        {mode === 'password' && (
          <>
            <PasswordInput
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="パスワード"
              autoComplete="current-password"
              minLength={8}
            />
            <p className="text-right">
              <Link
                href="/forgot-password"
                className="text-sm text-gizirotto-blue-700 hover:underline"
              >
                パスワードをお忘れですか？
              </Link>
            </p>
          </>
        )}

        {error && <p className="text-red-600 text-sm whitespace-pre-line">{error}</p>}

        <TurnstileWidget onToken={setTurnstileToken} />

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-gizirotto-blue-500 hover:bg-gizirotto-blue-700 text-white font-medium py-2 rounded disabled:opacity-50"
        >
          {loading
            ? mode === 'magic'
              ? '送信中…'
              : 'ログイン中…'
            : mode === 'magic'
              ? 'ログインリンクを送る'
              : 'ログイン'}
        </button>
      </form>
    </main>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  )
}
