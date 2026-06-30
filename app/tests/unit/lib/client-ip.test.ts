import { describe, it, expect, vi, beforeEach } from 'vitest'

// @vercel/functions mock — controls ipAddress() return value per test
vi.mock('@vercel/functions', () => ({
  ipAddress: vi.fn(),
}))

import { ipAddress } from '@vercel/functions'
import { parseXffFirst, getClientIp, getClientIpFromHeaders } from '@/lib/client-ip'

const mockIpAddress = ipAddress as ReturnType<typeof vi.fn>

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/test', { headers })
}

// -----------------------------------------------------------------------
// parseXffFirst — pure function, no mocks needed
// -----------------------------------------------------------------------

describe('parseXffFirst', () => {
  it('returns null for null input', () => {
    expect(parseXffFirst(null)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseXffFirst('')).toBeNull()
  })

  it('returns the first IP, trimmed, from a multi-entry value', () => {
    expect(parseXffFirst('  1.2.3.4 , 5.6.7.8')).toBe('1.2.3.4')
  })

  it('returns the single entry when there is only one', () => {
    expect(parseXffFirst('203.0.113.1')).toBe('203.0.113.1')
  })

  it('trims leading/trailing whitespace from the first entry', () => {
    expect(parseXffFirst('   192.0.2.1   , 10.0.0.1')).toBe('192.0.2.1')
  })
})

// -----------------------------------------------------------------------
// getClientIp — priority chain
// -----------------------------------------------------------------------

describe('getClientIp', () => {
  beforeEach(() => {
    mockIpAddress.mockReset()
  })

  it('returns ipAddress() result when available (highest priority)', () => {
    mockIpAddress.mockReturnValue('100.200.100.200')
    const req = makeRequest({ 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '9.9.9.9' })
    expect(getClientIp(req)).toBe('100.200.100.200')
  })

  it('falls back to XFF first entry when ipAddress() returns undefined', () => {
    mockIpAddress.mockReturnValue(undefined)
    // Vercel overwrites XFF; first entry is the confirmed client IP
    const req = makeRequest({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' })
    expect(getClientIp(req)).toBe('1.2.3.4')
  })

  it('uses XFF first entry, not the last (no tail-adoption)', () => {
    mockIpAddress.mockReturnValue(undefined)
    const req = makeRequest({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' })
    // Assert first is used and last is NOT used
    const result = getClientIp(req)
    expect(result).toBe('1.2.3.4')
    expect(result).not.toBe('5.6.7.8')
  })

  it('falls back to x-real-ip when ipAddress() is undefined and XFF is absent', () => {
    mockIpAddress.mockReturnValue(undefined)
    const req = makeRequest({ 'x-real-ip': '203.0.113.42' })
    expect(getClientIp(req)).toBe('203.0.113.42')
  })

  it('returns "anonymous" when all sources are absent', () => {
    mockIpAddress.mockReturnValue(undefined)
    const req = makeRequest()
    expect(getClientIp(req)).toBe('anonymous')
  })

  it('skips XFF and uses x-real-ip when XFF is empty string', () => {
    mockIpAddress.mockReturnValue(undefined)
    const req = makeRequest({ 'x-forwarded-for': '', 'x-real-ip': '10.0.0.1' })
    expect(getClientIp(req)).toBe('10.0.0.1')
  })
})

// -----------------------------------------------------------------------
// getClientIpFromHeaders — Server Action variant (no Request object)
// -----------------------------------------------------------------------

function makeHeaders(record: Record<string, string>): { get(name: string): string | null } {
  return { get: (name: string) => record[name] ?? null }
}

describe('getClientIpFromHeaders', () => {
  it('returns the first XFF entry', () => {
    const h = makeHeaders({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' })
    expect(getClientIpFromHeaders(h)).toBe('1.2.3.4')
  })

  it('falls back to x-real-ip when XFF is absent', () => {
    const h = makeHeaders({ 'x-real-ip': '203.0.113.42' })
    expect(getClientIpFromHeaders(h)).toBe('203.0.113.42')
  })

  it('returns "anonymous" when all header sources are absent', () => {
    const h = makeHeaders({})
    expect(getClientIpFromHeaders(h)).toBe('anonymous')
  })

  it('returns "anonymous" when XFF is empty and x-real-ip is absent', () => {
    const h = makeHeaders({ 'x-forwarded-for': '' })
    expect(getClientIpFromHeaders(h)).toBe('anonymous')
  })

  it('trims whitespace from the first XFF entry', () => {
    const h = makeHeaders({ 'x-forwarded-for': '  10.0.0.1  , 10.0.0.2' })
    expect(getClientIpFromHeaders(h)).toBe('10.0.0.1')
  })
})
