import { describe, it, expect } from 'vitest'
import {
  INVITE_CODE_LENGTH,
  INVITE_CODE_TTL_DAYS,
  computeInviteCodeExpiresAt,
  generateInviteCode,
  isInviteCodeExpired,
  isValidInviteCodeFormat,
} from '@/lib/invite-code'

describe('invite-code', () => {
  it('generates code with correct length', () => {
    const code = generateInviteCode()
    expect(code).toHaveLength(INVITE_CODE_LENGTH)
  })

  it('excludes ambiguous characters I, O, 0, 1', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateInviteCode()
      expect(code).not.toMatch(/[IO01]/)
    }
  })

  it('uses only allowed alphabet', () => {
    const allowed = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/
    for (let i = 0; i < 200; i++) {
      const code = generateInviteCode()
      expect(code).toMatch(allowed)
    }
  })

  it('generates unique codes in batch (no collision in 1000 samples)', () => {
    const set = new Set<string>()
    for (let i = 0; i < 1000; i++) set.add(generateInviteCode())
    expect(set.size).toBe(1000)
  })

  it('computes expires-at exactly 7 days ahead', () => {
    const now = new Date('2026-05-23T00:00:00Z')
    const exp = computeInviteCodeExpiresAt(now)
    const diffDays = (exp.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
    expect(diffDays).toBe(INVITE_CODE_TTL_DAYS)
  })

  it('detects expired code', () => {
    const past = new Date('2020-01-01T00:00:00Z')
    expect(isInviteCodeExpired(past)).toBe(true)
  })

  it('treats future code as not expired', () => {
    const future = new Date(Date.now() + 60_000)
    expect(isInviteCodeExpired(future)).toBe(false)
  })

  it('accepts iso string for expiresAt', () => {
    const past = new Date('2020-01-01T00:00:00Z').toISOString()
    expect(isInviteCodeExpired(past)).toBe(true)
  })

  it('validates format correctly', () => {
    const valid = generateInviteCode()
    expect(isValidInviteCodeFormat(valid)).toBe(true)
    expect(isValidInviteCodeFormat('SHORT')).toBe(false)
    expect(isValidInviteCodeFormat('ABCDEFGHIJ')).toBe(false) // contains I
    expect(isValidInviteCodeFormat('ABCDEFGHJ0')).toBe(false) // contains 0
    expect(isValidInviteCodeFormat('ABCDEFGHJ1')).toBe(false) // contains 1
    expect(isValidInviteCodeFormat('abcdefghjk')).toBe(false) // lowercase
    expect(isValidInviteCodeFormat('ABCDEFGHJKL')).toBe(false) // 11 chars
  })
})
