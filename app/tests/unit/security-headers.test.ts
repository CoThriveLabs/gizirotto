/**
 * セキュリティヘッダのスナップショットテスト。
 * 将来うっかり directive が削れる事故を CI で検出する。
 */
import { describe, it, expect } from 'vitest'
import { SECURITY_HEADERS } from '../../next.config.mjs'

interface HeaderEntry {
  key: string
  value: string
}

function findHeader(key: string): HeaderEntry {
  const h = (SECURITY_HEADERS as HeaderEntry[]).find((x) => x.key === key)
  if (!h) throw new Error(`header not found: ${key}`)
  return h
}

describe('SECURITY_HEADERS', () => {
  it('Strict-Transport-Security: max-age 2 年 + includeSubDomains + preload 含めない', () => {
    const h = findHeader('Strict-Transport-Security')
    expect(h.value).toBe('max-age=63072000; includeSubDomains')
    expect(h.value).not.toContain('preload')
  })

  it('X-Frame-Options: DENY', () => {
    expect(findHeader('X-Frame-Options').value).toBe('DENY')
  })

  it('X-Content-Type-Options: nosniff', () => {
    expect(findHeader('X-Content-Type-Options').value).toBe('nosniff')
  })

  it('Referrer-Policy: strict-origin-when-cross-origin', () => {
    expect(findHeader('Referrer-Policy').value).toBe(
      'strict-origin-when-cross-origin',
    )
  })

  it('Permissions-Policy: camera / microphone / geolocation / interest-cohort 等を全 deny', () => {
    const v = findHeader('Permissions-Policy').value
    expect(v).toContain('camera=()')
    expect(v).toContain('microphone=()')
    expect(v).toContain('geolocation=()')
    expect(v).toContain('interest-cohort=()')
  })

  it('Cross-Origin-Opener-Policy: same-origin', () => {
    expect(findHeader('Cross-Origin-Opener-Policy').value).toBe('same-origin')
  })

  it('Cross-Origin-Resource-Policy: same-origin', () => {
    expect(findHeader('Cross-Origin-Resource-Policy').value).toBe('same-origin')
  })

  it('CSP は Report-Only モードのみ（enforce ヘッダは出さない）', () => {
    const enforce = (SECURITY_HEADERS as HeaderEntry[]).find(
      (x) => x.key === 'Content-Security-Policy',
    )
    const reportOnly = (SECURITY_HEADERS as HeaderEntry[]).find(
      (x) => x.key === 'Content-Security-Policy-Report-Only',
    )
    expect(enforce).toBeUndefined()
    expect(reportOnly).toBeDefined()
  })

  it('CSP directives に必要な外部 origin がすべて含まれる', () => {
    const csp = findHeader('Content-Security-Policy-Report-Only').value
    // Supabase（REST + WSS + Storage）
    expect(csp).toContain('https://*.supabase.co')
    expect(csp).toContain('wss://*.supabase.co')
    // Turnstile（script + frame + connect）
    expect(csp).toContain('https://challenges.cloudflare.com')
    // 基本 directive
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain('upgrade-insecure-requests')
  })

  it('Cross-Origin-Embedder-Policy は設定しない（Supabase Storage 互換性のため）', () => {
    const coep = (SECURITY_HEADERS as HeaderEntry[]).find(
      (x) => x.key === 'Cross-Origin-Embedder-Policy',
    )
    expect(coep).toBeUndefined()
  })
})
