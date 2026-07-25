import { createSupabaseServerClient } from '@/lib/supabase/server'
import { hasCurrentConsent } from '@/lib/legal/consent-check'
import { decodeAccessTokenClaims } from '@/lib/jwt-claims'
import { ConsentModal } from './ConsentModal'

/**
 * 認証済みユーザーの user_consents 最新レコードを確認し、
 * 現行バージョンに対する同意が無ければ強制モーダルを表示する Server Component。
 *
 * - 認証未確認時は何も描画しない（呼び出し側で認証チェック済み前提）。
 * - DB アクセスに失敗した場合は安全側に倒してモーダルを出さない（ログイン直後の race を避ける）。
 *   → 規約改定タイミングで一時的に skip するリスクはあるが、UX 阻害を優先回避。
 *
 * family 未参加判定は JWT claims（access_token の family_id）でのみ行う。middleware が注入する
 * x-family-id ヘッダーは、family 参加済みでも早期 return するパスでは設定されないことがあり、
 * その値をここで判定材料に使うと family 参加済みユーザーを未参加と誤判定しうる。
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

  const {
    data: { session },
  } = await supabase.auth.getSession()
  const needsFamilySetup = !decodeAccessTokenClaims(session?.access_token)?.family_id

  return <ConsentModal needsFamilySetup={needsFamilySetup} />
}
