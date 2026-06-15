/**
 * エラーコード → 素人向け日本語メッセージ。
 *
 * 目的: WHITEOUT_RASTERIZE_FAILED / preview failed:500 / ANTHROPIC_API_KEY_MISSING のような
 *   技術的エラーを、素人が見て「何が起きて何をすれば」分かる日本語に変換する。
 *
 * 方針:
 *   - サーバが投げるエラーコード文字列（`Error(CODE)` / API の `{ error: CODE }`）は無改変。
 *     本モジュールは「表示する直前」に humanizeErrorCode で日本語へ写すだけ（サーバ/クライアント両用の純関数）。
 *   - 未知コードはカテゴリのフォールバック規則で必ず日本語に落とす（生コードを素人に見せない）。
 *   - 詳細折りたたみに出してよいのは「エラーコード」だけ。detail/status 等の生メッセージは
 *     UI 側でも出さない（Supabase メッセージ・内部パス・個人情報の漏洩防止）。
 */

/** エラーカテゴリ（A〜E）。UI 側の色分け等に使える。 */
export type ErrorCategory = 'A' | 'B' | 'C' | 'D' | 'E'

/** humanizeErrorCode の戻り値。message=主表示文・category=分類・rawCode=折りたたみに出す元コード。 */
export interface HumanizedError {
  message: string
  category: ErrorCategory
  /** 詳細折りたたみ用。抽出できた既知コード、無ければ入力文字列のトリム（UI で「エラーコード:」として出す）。 */
  rawCode: string
}

/** 5 カテゴリの既定文（未知コードのフォールバック先・個別文言が無いコードの共通文）。 */
const CATEGORY_DEFAULT: Record<ErrorCategory, string> = {
  A: 'このファイルは読み込めない形式のようです。別の PDF（印刷・スキャンしたもの等）でもう一度お試しください。',
  B: '一時的なエラーが起きました。少し時間をおいて、もう一度お試しください。',
  C: 'サービスの設定に問題があります。お手数ですが管理者までお問い合わせください。',
  D: 'この操作は行えませんでした。お手数ですが画面を再読み込みしてお試しください。',
  E: '予期しないエラーが起きました。時間をおいて再度お試しください。続く場合は詳細を添えてお問い合わせください。',
}

interface CatalogEntry {
  category: ErrorCategory
  /** 個別文言（省略時はカテゴリ既定文を使う）。 */
  message?: string
}

/**
 * 既知エラーコード → カテゴリ/文言。サーバ側 throw / API `{error}` のコード名と一致させる。
 * 個別 message が無いコードはカテゴリ既定文（CATEGORY_DEFAULT）にフォールバックする。
 */
export const ERROR_CATALOG: Record<string, CatalogEntry> = {
  // ── A 形式・内容が非対応 ───────────────────────────────────────────────
  NOT_A_PDF_TEMPLATE: {
    category: 'A',
    message: 'PDF のテンプレートではないため、この操作はできません。',
  },
  BBOX_OUT_OF_RANGE: {
    category: 'A',
    message: '枠がページの外にはみ出しています。ページ内に収めてください。',
  },
  WHITEOUT_RASTERIZE_FAILED: { category: 'A' },
  IMAGE_RENDER_FAILED: { category: 'A' },
  IMAGE_RENDER_TIMEOUT: { category: 'A' },
  INVALID_JSON: { category: 'A' },
  INVALID_REQUEST: { category: 'A' },
  TEMPLATE_BUNDLE_INVALID: { category: 'A' },
  TEMPLATE_BUNDLE_UNSUPPORTED: { category: 'A' },
  EMPTY_FILE: { category: 'A' },
  FILE_TOO_LARGE: {
    category: 'A',
    message: 'ファイルが大きすぎます。10MB までのファイルでお試しください。',
  },

  // ── B 一時的・再試行 ──────────────────────────────────────────────────
  DB_ERROR: { category: 'B' },
  SAVE_FAILED: { category: 'B' },
  PAGE_NOT_FOUND: { category: 'B' },
  PDF_DOWNLOAD_FAILED: { category: 'B' },
  STORAGE_UPLOAD_FAILED: { category: 'B' },
  DB_UPDATE_FAILED: { category: 'B' },
  WHITEOUT_APPLY_FAILED: { category: 'B' },
  WHITEOUT_OCR_FAILED: { category: 'B' },
  CLOUDCONVERT_UPLOAD_FAILED: { category: 'B' },
  CLOUDCONVERT_FAILED: { category: 'B' },
  OVERLAY_FAILED: { category: 'B' },

  // ── C API・設定（管理者） ─────────────────────────────────────────────
  ANTHROPIC_API_KEY_MISSING: { category: 'C' },
  AI_NOT_CONFIGURED: { category: 'C' },
  CLOUDCONVERT_API_KEY_MISSING: { category: 'C' },
  ANTHROPIC_MODEL_MISSING: { category: 'C' },

  // ── D 操作・権限・状態 ────────────────────────────────────────────────
  UNAUTHENTICATED: {
    category: 'D',
    message: 'ログインの有効期限が切れました。もう一度ログインしてください。',
  },
  NOT_IN_FAMILY: {
    category: 'D',
    message: 'ログインの有効期限が切れました。もう一度ログインしてください。',
  },
  CONFLICT: {
    category: 'D',
    message: 'ほかの場所で内容が更新されました。画面を再読み込みしてください。',
  },
  NAME_SET_MISMATCH: {
    category: 'D',
    message: 'ほかの場所で内容が更新されました。画面を再読み込みしてください。',
  },
  FORBIDDEN: { category: 'D', message: 'この操作を行う権限がありません。' },
  CANNOT_EDIT_DEFAULT: {
    category: 'D',
    message: 'サンプルテンプレートは編集できません。',
  },
  CANNOT_DELETE_DEFAULT: {
    category: 'D',
    message: 'サンプルテンプレートは削除できません。',
  },
  NOT_FOUND: {
    category: 'D',
    message: '対象が見つかりませんでした。削除された可能性があります。',
  },
  MISSING_TEMPLATE_ID: {
    category: 'D',
    message: '対象が見つかりませんでした。削除された可能性があります。',
  },
  // bbox 編集（枠の追加/分割/削除）由来。
  FIELD_COUNT_OUT_OF_RANGE: {
    category: 'D',
    message: '枠は 1〜20 個までです。',
  },
  INVALID_LABEL: {
    category: 'D',
    message: '項目名は 1〜40 文字で入力してください。',
  },
  NAME_GEN_FAILED: {
    category: 'D',
    message: '枠を追加できませんでした。お手数ですが画面を再読み込みしてお試しください。',
  },

  // family/join 由来（旧 _form.tsx の独自辞書を統合・文言流用）。
  INVALID_CODE: {
    category: 'D',
    message: '招待コードが正しくありません。',
  },
  CODE_EXPIRED: {
    category: 'D',
    message: '招待コードの有効期限が切れています。ご家族に再発行を依頼してください。',
  },
  ALREADY_IN_FAMILY: {
    category: 'D',
    message: '既に他の家族に所属しています。',
  },
  INVALID_DISPLAY_NAME: {
    category: 'D',
    message: '表示名を 1-20 文字で入力してください。',
  },
}

/**
 * 文字列に日本語（ひらがな/カタカナ/漢字）が含まれるか。
 *
 * サーバ/Supabase が返すメッセージが「既に日本語で親切」なら温存し、英文/生コードのときだけ
 * humanizeErrorCode に通す判定に使う。
 */
export function containsJapanese(text: string | null | undefined): boolean {
  if (!text) return false
  // ひらがな(3040-309F) / カタカナ(30A0-30FF) / CJK統合漢字(4E00-9FFF)
  return /[぀-ゟ゠-ヿ一-鿿]/.test(text)
}

/** 既知コードを「長い順」に持っておく（部分一致抽出で `DB_UPDATE_FAILED` を `DB_ERROR` より先に当てる）。 */
const KNOWN_CODES_BY_LENGTH = Object.keys(ERROR_CATALOG).sort((a, b) => b.length - a.length)

/** 文字列中から最初に現れる既知コード（最長一致優先）を抜き出す。無ければ null。 */
function extractKnownCode(input: string): string | null {
  const upper = input.toUpperCase()
  for (const code of KNOWN_CODES_BY_LENGTH) {
    if (upper.includes(code)) return code
  }
  return null
}

/** 文字列中の HTTP ステータス（`failed: 500` / `status 404` 等）を拾う。無ければ null。 */
function extractHttpStatus(input: string): number | null {
  const m = input.match(/\b([45]\d\d)\b/)
  return m ? Number(m[1]) : null
}

/**
 * 未知コードのフォールバック分類:
 *   - `*_FAILED` → B（一時的・再試行）
 *   - `*_MISSING` → C（設定・管理者）
 *   - HTTP 4xx → D（操作・権限・状態） / 5xx → B（一時的）
 *   - その他 → E（予期しないエラー）
 */
function fallbackCategory(token: string, httpStatus: number | null): ErrorCategory {
  const upper = token.toUpperCase()
  if (upper.endsWith('_FAILED')) return 'B'
  if (upper.endsWith('_MISSING')) return 'C'
  if (httpStatus !== null) {
    if (httpStatus >= 500) return 'B'
    if (httpStatus >= 400) return 'D'
  }
  return 'E'
}

/**
 * エラーコード（または生メッセージ文字列）→ 素人向け日本語。
 *
 * 入力は「裸のコード（`Error(CODE)` の message）」でも「`preview failed: 500 {…}` のような
 * 合成文字列」でも受ける。既知コードを最長一致で抽出し、無ければ語尾/HTTP ステータスで分類する。
 * 生メッセージはそのまま表示に使わない（rawCode に抽出コード or トリム文字列だけ載せる）。
 */
export function humanizeErrorCode(code: string | null | undefined): HumanizedError {
  const input = (code ?? '').trim()
  if (input === '') {
    return { message: CATEGORY_DEFAULT.E, category: 'E', rawCode: 'UNKNOWN' }
  }

  const known = extractKnownCode(input)
  if (known) {
    const entry = ERROR_CATALOG[known]
    return {
      message: entry.message ?? CATEGORY_DEFAULT[entry.category],
      category: entry.category,
      rawCode: known,
    }
  }

  // 未知: フォールバック分類。rawCode はコード様トークン（英大文字/数字/_）を優先、無ければ入力短縮。
  const httpStatus = extractHttpStatus(input)
  const codeToken = input.match(/[A-Z][A-Z0-9_]{2,}/)?.[0] ?? input
  const category = fallbackCategory(codeToken, httpStatus)
  return {
    message: CATEGORY_DEFAULT[category],
    category,
    rawCode: httpStatus !== null && !/[A-Z][A-Z0-9_]{2,}/.test(input)
      ? `HTTP_${httpStatus}`
      : codeToken.slice(0, 64),
  }
}
