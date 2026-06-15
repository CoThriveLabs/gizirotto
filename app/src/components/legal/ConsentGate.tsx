import { createSupabaseServerClient } from '@/lib/supabase/server'
import { hasCurrentConsent } from '@/lib/legal/consent-check'
import { ConsentModal } from './ConsentModal'

/**
 * 認証済みユーザーの user_consents 最新レコードを確認し、
 * 現行バージョンに対する同意が無ければ強制モーダルを表示する Server Component。
 *
 * - 認証未確認時は何も描画しない（呼び出し側で認証チェック済み前提）。
 * - DB アクセスに失敗した場合は安全側に倒してモーダルを出さない（ログイン直後の race を避ける）。
 *   → 規約改定タイミングで一時的に skip するリスクはあるが、UX 阻害を優先回避。
 */
export async function ConsentGate() {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  try {
    const ok = await hasCurrentConsent(supabase, user.id)
    if (ok) return null
  } catch {
    return null
  }

  return <ConsentModal />
}
