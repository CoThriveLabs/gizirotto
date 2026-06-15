'use client'

import { createSupabaseBrowserClient } from '@/lib/supabase/client'

/**
 * refreshSession() 後も family_id クレームが空のフォールバックダイアログ。
 */
export function FamilyClaimNotReflectedDialog() {
  async function handleLogout() {
    const supabase = createSupabaseBrowserClient()
    await supabase.auth.signOut()
    window.location.href = '/login'
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="family-claim-fallback-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
    >
      <div className="bg-white rounded-lg max-w-sm w-full p-6 space-y-4 shadow-xl">
        <h2
          id="family-claim-fallback-title"
          className="text-lg font-semibold text-gizirotto-blue-900"
        >
          家族の反映に時間がかかっています
        </h2>
        <p className="text-sm text-gray-700">
          一度ログアウトして再ログインしてください。再ログイン後にご家族の画面が表示されます。
        </p>
        <button
          type="button"
          onClick={handleLogout}
          className="w-full bg-gizirotto-blue-500 hover:bg-gizirotto-blue-700 text-white font-medium py-2 rounded"
        >
          ログアウトしてやり直す
        </button>
      </div>
    </div>
  )
}
