'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, usePathname } from 'next/navigation'

/**
 * 初回ログイン同意モーダル。
 * - バックドロップクリック / Esc / x ボタンでは閉じない（強制表示）。
 * - 利用規約・プライバシーポリシー両方のチェックで「同意して始める」を活性化。
 * - 「利用規約」「プライバシーポリシー」テキストはリンク（新規タブ）。
 * - 同意成功時は /api/consent に POST する。家族未参加（needsFamilySetup）かつホーム画面
 *   （pathname === '/'）で同意した場合のみ /family/setup へ replace し、それ以外は現在の
 *   ルートを refresh して通常表示に戻る。
 *
 * pathname を '/' 完全一致で見る理由: このモーダルは root layout にぶら下がっており、
 * /family/join（招待リンク）や /minutes/new/adjust（ゲスト下書き復元）等、既に目的地のある
 * 画面にも表示されうる。startsWith 等で緩めると、招待コード付き URL や下書き復元中の同意で
 * その目的地への遷移を横取りしてしまう。
 */
export function ConsentModal({ needsFamilySetup }: { needsFamilySetup: boolean }) {
  const router = useRouter()
  const pathname = usePathname()
  const [termsAgreed, setTermsAgreed] = useState(false)
  const [privacyAgreed, setPrivacyAgreed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * 同意記録に成功したら自前で閉じる。
   *
   * このモーダルを出す ConsentGate は root layout 直下の server component で、App Router は
   * 共有レイアウトをクライアント遷移で再描画しない。つまり router.replace() だけでは
   * ConsentGate が再評価されず、全画面オーバーレイ（fixed inset-0）が遷移先に残り続けて
   * 操作不能になる。親の再描画に依存せず、モーダル自身が閉じられるようにする。
   */
  const [done, setDone] = useState(false)

  // Esc キーで閉じない（preventDefault）
  useEffect(() => {
    if (done) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [done])

  // body スクロール抑制。done 後もこの component は mount されたまま残りうる（上記参照）ので、
  // unmount の cleanup ではなく done を依存に入れて解除する。
  useEffect(() => {
    if (done) return
    const original = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = original
    }
  }, [done])

  const canSubmit = termsAgreed && privacyAgreed && !submitting

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ termsAgreed, privacyAgreed }),
      })
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(json.error ?? '同意の記録に失敗しました')
      }
      // 遷移するかどうかに関わらず、まずモーダル自身を閉じる（done の宣言部を参照）。
      setDone(true)
      if (needsFamilySetup && pathname === '/') {
        // refresh は「現在のルート」を対象にするため replace と競合する。遷移先の
        // /family/setup は最新の RSC で描画されるので、この経路では refresh を呼ばない。
        router.replace('/family/setup')
        return
      }
      // 同じルートに留まる経路。ConsentGate は server component なので、RSC を取り直させて
      // 次回以降の描画で ConsentGate に null を返させる。
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : '同意の記録に失敗しました')
      setSubmitting(false)
    }
  }, [canSubmit, termsAgreed, privacyAgreed, router, needsFamilySetup, pathname])

  if (done) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="consent-modal-title"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
    >
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <h2
          id="consent-modal-title"
          className="text-xl font-serif text-gizirotto-blue-900"
        >
          ご利用にあたって
        </h2>
        <p className="text-sm text-gray-700">
          ぎじろっとをご利用いただくには、利用規約とプライバシーポリシーへの同意が必要です。内容をご確認のうえ、以下のチェックをお願いします。
        </p>

        <div className="space-y-3">
          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={termsAgreed}
              onChange={(e) => setTermsAgreed(e.target.checked)}
              className="mt-1 h-4 w-4 shrink-0 accent-gizirotto-blue-700"
              aria-label="利用規約に同意"
            />
            <span className="text-gray-800">
              <a
                href="/legal/terms"
                target="_blank"
                rel="noopener noreferrer"
                className="text-gizirotto-blue-700 underline hover:text-gizirotto-blue-900"
              >
                利用規約
              </a>
              に同意します
            </span>
          </label>

          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={privacyAgreed}
              onChange={(e) => setPrivacyAgreed(e.target.checked)}
              className="mt-1 h-4 w-4 shrink-0 accent-gizirotto-blue-700"
              aria-label="プライバシーポリシーに同意"
            />
            <span className="text-gray-800">
              <a
                href="/legal/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-gizirotto-blue-700 underline hover:text-gizirotto-blue-900"
              >
                プライバシーポリシー
              </a>
              に同意します
            </span>
          </label>
        </div>

        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="w-full rounded-md bg-gizirotto-blue-700 text-white py-2.5 text-sm font-medium hover:bg-gizirotto-blue-800 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
        >
          {submitting ? '記録中…' : '同意して始める'}
        </button>

        <p className="text-xs text-gray-500">
          同意取得日時とバージョンを記録します。規約改定時は再度同意をお願いする場合があります。
        </p>
      </div>
    </div>
  )
}
