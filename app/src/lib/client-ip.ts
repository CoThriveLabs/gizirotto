import 'server-only'
import { ipAddress } from '@vercel/functions'

// Extracts the first (trusted) entry from an X-Forwarded-For header value.
// Vercel overwrites XFF at the edge and drops client-supplied spoofed values,
// so the first entry is the confirmed client IP in a direct Vercel deployment.
export function parseXffFirst(headerValue: string | null): string | null {
  if (!headerValue) return null
  const first = headerValue.split(',')[0]?.trim()
  return first || null
}

// Returns the best available client IP for rate-limiting purposes.
// Priority: Vercel platform API → XFF first entry → x-real-ip → 'anonymous'.
export function getClientIp(req: Request): string {
  return (
    ipAddress(req) ??
    parseXffFirst(req.headers.get('x-forwarded-for')) ??
    req.headers.get('x-real-ip') ??
    'anonymous'
  )
}

// For Server Actions, where the Request object is not directly accessible.
// Reads XFF and x-real-ip from the headers() list provided by next/headers.
export function getClientIpFromHeaders(h: { get(name: string): string | null }): string {
  return parseXffFirst(h.get('x-forwarded-for')) ?? h.get('x-real-ip') ?? 'anonymous'
}
