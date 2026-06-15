import { TERMS_VERSION, PRIVACY_VERSION } from './versions'

/**
 * 現行バージョンに対する同意レコードが user_consents に存在するか確認する。
 * - 同一 user_id で最新の consented_at レコードを取得し、terms_version / privacy_version を比較。
 * - 完全一致しない（未登録・古いバージョン）場合は再同意が必要。
 *
 * Supabase クライアントの型はプロジェクト内で複数経路から来るため any で受ける。
 * RLS により他ユーザーの行は取得できないため、user_id 引数の検証は不要。
 */
export async function hasCurrentConsent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  userId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('user_consents')
    .select('terms_version, privacy_version')
    .eq('user_id', userId)
    .order('consented_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error || !data) return false

  return (
    data.terms_version === TERMS_VERSION &&
    data.privacy_version === PRIVACY_VERSION
  )
}
