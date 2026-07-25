/**
 * `next` クエリパラメータの安全性チェック（open redirect 対策）。
 * 「same-origin path only」準拠。
 *
 * 安全と判定される条件:
 * - 空でない文字列
 * - `//` または `/\` で始まらない（protocol-relative URL 攻撃防止）
 * - `new URL(next, origin)` が同一オリジン
 *
 * 不適合時は null を返す。呼び出し側で `next ?? '/'` 等にフォールバックする想定。
 */
export function sanitizeNextParam(
  next: string | null | undefined,
  origin: string,
): string | null {
  if (!next || typeof next !== 'string') return null
  if (next.startsWith('//') || next.startsWith('/\\')) return null
  try {
    const parsed = new URL(next, origin)
    if (parsed.origin !== origin) return null
    return parsed.pathname + parsed.search + parsed.hash
  } catch {
    return null
  }
}

/**
 * `next` クエリパラメータの安全性チェック（origin 非依存版）。
 * server component から `origin` を用意せずに使えるよう、`new URL` を使わず
 * 文字列判定のみで same-origin path であることを確認する。
 *
 * 安全と判定される条件:
 * - 空でない文字列
 * - `/` から始まる（絶対 URL・スキーム相対 URL を排除）
 * - `//` または `/\` で始まらない（protocol-relative URL 攻撃防止）
 * - 制御文字（0x00-0x1f）を含まない
 *
 * 不適合時は null を返す。呼び出し側で `next ?? '/'` 等にフォールバックする想定。
 */
export function sanitizeRelativeNext(
  next: string | null | undefined,
): string | null {
  if (!next || typeof next !== 'string') return null
  if (!next.startsWith('/')) return null
  if (next.startsWith('//') || next.startsWith('/\\')) return null
  if (/[\x00-\x1f]/.test(next)) return null
  return next
}
