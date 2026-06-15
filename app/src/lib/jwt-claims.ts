/**
 * JWT claims decode（payload のみ取り出す、署名検証なし）。
 *
 * 用途: Supabase `auth.getUser()` で user identity を検証済の前提で、
 * `session.access_token` から custom_access_token_hook が注入した
 * カスタムクレーム（family_id 等）を取り出すための補助。
 *
 * 注意:
 * - 署名検証は呼び出し前に getUser() で完了している必要がある（生 cookie 由来の token を直接 decode しないこと）。
 * - Edge Runtime / Node Runtime 両対応のため atob ベースで実装（Buffer 非依存）。
 *
 * 注記: `user.app_metadata.family_id` 経由は機能しない
 * （Supabase の app_metadata は auth.users.raw_app_meta_data 列の中身で、
 *  custom_access_token_hook が JWT claims に注入した値とは別管理）。
 *  family_id を読むには JWT claims を直接 decode する必要がある。
 */

export type SupabaseAccessTokenClaims = {
  sub?: string
  family_id?: string
  [key: string]: unknown
}

function base64UrlDecode(input: string): string {
  // base64url → base64 へ変換 + padding 補完
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  if (typeof atob === 'function') {
    const binary = atob(padded)
    let result = ''
    for (let i = 0; i < binary.length; i++) {
      result += String.fromCharCode(binary.charCodeAt(i))
    }
    // UTF-8 へ復号
    try {
      return decodeURIComponent(escape(result))
    } catch {
      return result
    }
  }
  // 万一 atob が無い環境向けフォールバック（Node 16 以降は globalThis.atob 有り）
  return Buffer.from(padded, 'base64').toString('utf8')
}

export function decodeAccessTokenClaims(
  accessToken: string | null | undefined,
): SupabaseAccessTokenClaims | null {
  if (!accessToken) return null
  const parts = accessToken.split('.')
  if (parts.length < 2) return null
  try {
    const json = base64UrlDecode(parts[1])
    return JSON.parse(json) as SupabaseAccessTokenClaims
  } catch {
    return null
  }
}
