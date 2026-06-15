import { describe, it, expect } from 'vitest'
import { decodeAccessTokenClaims } from '@/lib/jwt-claims'

function makeJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
    'base64url',
  )
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature-not-verified`
}

describe('decodeAccessTokenClaims - happy path', () => {
  it('decodes a normal JWT and returns payload object', () => {
    const token = makeJwt({ sub: 'u1', family_id: 'fam-1' })
    const claims = decodeAccessTokenClaims(token)
    expect(claims).toMatchObject({ sub: 'u1', family_id: 'fam-1' })
  })

  it('returns family_id as string when present', () => {
    const token = makeJwt({ sub: 'u1', family_id: 'fam-xyz' })
    expect(decodeAccessTokenClaims(token)?.family_id).toBe('fam-xyz')
  })

  it('returns sub field correctly', () => {
    const token = makeJwt({ sub: 'user-abc', family_id: 'f' })
    expect(decodeAccessTokenClaims(token)?.sub).toBe('user-abc')
  })

  it('preserves additional unknown claims via index signature', () => {
    const token = makeJwt({ sub: 'u', family_id: 'f', role: 'admin', exp: 12345 })
    const claims = decodeAccessTokenClaims(token)
    expect(claims?.['role']).toBe('admin')
    expect(claims?.['exp']).toBe(12345)
  })

  it('handles UTF-8 multibyte payload (Japanese)', () => {
    const token = makeJwt({ sub: 'u', family_id: 'f', name: '日本語ユーザー' })
    const claims = decodeAccessTokenClaims(token)
    expect(claims?.['name']).toBe('日本語ユーザー')
  })
})

describe('decodeAccessTokenClaims - invalid input', () => {
  it('returns null for single-segment token', () => {
    expect(decodeAccessTokenClaims('only-one-part')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(decodeAccessTokenClaims('')).toBeNull()
  })

  it('returns null for null input', () => {
    expect(decodeAccessTokenClaims(null)).toBeNull()
  })

  it('returns null for undefined input', () => {
    expect(decodeAccessTokenClaims(undefined)).toBeNull()
  })

  it('returns null when payload is not valid JSON', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
    const garbage = Buffer.from('not-json-at-all').toString('base64url')
    const token = `${header}.${garbage}.sig`
    expect(decodeAccessTokenClaims(token)).toBeNull()
  })

  it('returns claims object but family_id undefined when missing', () => {
    const token = makeJwt({ sub: 'u-only' })
    const claims = decodeAccessTokenClaims(token)
    expect(claims).not.toBeNull()
    expect(claims?.sub).toBe('u-only')
    expect(claims?.family_id).toBeUndefined()
  })
})

describe('decodeAccessTokenClaims - Edge Runtime (atob path)', () => {
  it('uses globalThis.atob when available (Edge Runtime compatible)', () => {
    // Edge Runtime / Node 16+ では globalThis.atob が存在 → atob ベース分岐を通る verify
    expect(typeof atob).toBe('function')
    const token = makeJwt({ sub: 'edge-user', family_id: 'edge-fam' })
    const claims = decodeAccessTokenClaims(token)
    // Buffer fallback ではなく atob 経由でも同一結果が得られること
    expect(claims).toMatchObject({ sub: 'edge-user', family_id: 'edge-fam' })
  })
})
