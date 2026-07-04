/**
 * Unit tests for resolveAllowedOrigin (src/lib/cors.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

describe('resolveAllowedOrigin', () => {
  const OLD_ENV = process.env

  beforeEach(() => {
    vi.resetModules()
    process.env = { ...OLD_ENV }
  })

  afterEach(() => {
    process.env = OLD_ENV
  })

  it('許可リスト内のオリジン → そのまま返す', async () => {
    process.env.ALLOWED_ORIGINS = 'https://example.com,https://app.example.com'
    const { resolveAllowedOrigin } = await import('@/lib/cors')
    expect(resolveAllowedOrigin('https://example.com')).toBe('https://example.com')
  })

  it('2 つ目の許可オリジン → そのまま返す', async () => {
    process.env.ALLOWED_ORIGINS = 'https://example.com,https://app.example.com'
    const { resolveAllowedOrigin } = await import('@/lib/cors')
    expect(resolveAllowedOrigin('https://app.example.com')).toBe('https://app.example.com')
  })

  it('許可リスト外のオリジン → null', async () => {
    process.env.ALLOWED_ORIGINS = 'https://example.com,https://app.example.com'
    const { resolveAllowedOrigin } = await import('@/lib/cors')
    expect(resolveAllowedOrigin('https://evil.com')).toBeNull()
  })

  it('origin ヘッダなし (null) → null', async () => {
    process.env.ALLOWED_ORIGINS = 'https://example.com,https://app.example.com'
    const { resolveAllowedOrigin } = await import('@/lib/cors')
    expect(resolveAllowedOrigin(null)).toBeNull()
  })

  it('ALLOWED_ORIGINS 未設定 → null', async () => {
    delete process.env.ALLOWED_ORIGINS
    const { resolveAllowedOrigin } = await import('@/lib/cors')
    expect(resolveAllowedOrigin('https://example.com')).toBeNull()
  })

  it('ALLOWED_ORIGINS が空文字 → null', async () => {
    process.env.ALLOWED_ORIGINS = ''
    const { resolveAllowedOrigin } = await import('@/lib/cors')
    expect(resolveAllowedOrigin('https://example.com')).toBeNull()
  })

  it('カンマ区切り前後の空白を無視する', async () => {
    process.env.ALLOWED_ORIGINS = ' https://example.com , https://app.example.com '
    const { resolveAllowedOrigin } = await import('@/lib/cors')
    expect(resolveAllowedOrigin('https://example.com')).toBe('https://example.com')
  })
})
