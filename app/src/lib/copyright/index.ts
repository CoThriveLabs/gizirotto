/**
 * 著作権予防策モジュール（設計書 v1.4.2 §9 / 仕様書 v1.6.1 §0-3.5 要件 4）。
 *
 * 4 つの責務:
 *   1. 利用規約条文 (license-text)
 *   2. 同意チェック保存 (license-consent)
 *   3. 商用ロゴ検出 (logo-detector, §9-3 L1+L2)
 *   4. 既知ロゴ DB (known-logos)
 *
 * 重要（C-9 / §9-0 厳守）:
 *   - 商用ロゴ検出時は「警告 + ユーザー確認」、自動拒否しない
 *   - §3-9 PdfEditorWatermarkFilter とは完全に別系統（§9-3a）
 */

export {
  LICENSE_COPYRIGHT_CLAUSE,
  TAKEDOWN_CONTACT_EMAIL,
  TAKEDOWN_RESPONSE_DAYS,
  UPLOAD_CONSENT_CHECKBOX_LABEL,
  INPUT_PATH_LABELS,
  COMMERCIAL_LOGO_WARNING_TEXT,
  COMMERCIAL_LOGO_WARNING_BUTTONS,
} from './license-text'

export {
  buildLicenseConsent,
  isLicenseConsentRecord,
  type LicenseConsentRecord,
} from './license-consent'

export {
  detectLogosByKeyword,
  confirmLogoByClaudeVision,
  detectCommercialLogos,
  type LogoDetectionMatch,
  type LogoDetectionResult,
  type ClaudeVisionClient,
  type ClaudeVisionInput,
} from './logo-detector'

export {
  KNOWN_COMMERCIAL_LOGOS,
  getKnownLogoById,
  getAllKeywordHints,
  type KnownLogoEntry,
} from './known-logos'
