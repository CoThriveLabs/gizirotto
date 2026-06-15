/**
 * 同意チェック保存ヘルパー。
 *
 * テンプレ登録 API から呼ばれ、`templates.license_consent` JSONB カラムに保存される構造を
 * 組み立てる。
 *
 * 重要:
 *   - 必須項目: user_id + agreed_at
 *   - agreed_at は ISO8601 UTC 文字列で保存
 *   - DB 保存 / 取得の実 I/O は呼び出し側（Route Handler）が担当
 */

/**
 * templates.license_consent JSONB の shape。
 * DB COMMENT: 「ユーザー同意チェック日時。著作権予防策」。
 */
export interface LicenseConsentRecord {
  /** 同意したユーザーの auth.users.id (UUID 文字列) */
  user_id: string
  /** 同意した日時 ISO8601 文字列（UTC） */
  agreed_at: string
}

/**
 * 同意レコードを組み立てる。
 *
 * @param userId    同意ユーザー（Supabase Auth getUser() 由来）
 * @param at        Date（省略時は new Date() = 現在 UTC）
 */
export function buildLicenseConsent(
  userId: string,
  at: Date = new Date(),
): LicenseConsentRecord {
  if (!userId || userId.length === 0) {
    throw new Error('LICENSE_CONSENT_USER_ID_REQUIRED')
  }
  return {
    user_id: userId,
    agreed_at: at.toISOString(),
  }
}

/**
 * unknown から LicenseConsentRecord として妥当か検証する（DB 読み出し後の type guard）。
 */
export function isLicenseConsentRecord(value: unknown): value is LicenseConsentRecord {
  if (value === null || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return (
    typeof r.user_id === 'string'
    && r.user_id.length > 0
    && typeof r.agreed_at === 'string'
    && r.agreed_at.length > 0
  )
}
