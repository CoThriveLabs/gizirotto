/**
 * Resolves the Access-Control-Allow-Origin value for a given request origin.
 * Returns the origin if it is in the allowlist, otherwise null (no CORS header).
 */
export function resolveAllowedOrigin(origin: string | null): string | null {
  const raw = process.env.ALLOWED_ORIGINS ?? ''
  if (!raw) return null
  const allowed = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))
  if (origin && allowed.has(origin)) return origin
  return null
}
