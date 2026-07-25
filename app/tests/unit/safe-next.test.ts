/**
 * sanitizeRelativeNext — origin 非依存の `next` クエリパラメータ検証（open redirect 対策）。
 */
import { describe, it, expect } from 'vitest'
import { sanitizeRelativeNext } from '@/lib/safe-next'

describe('sanitizeRelativeNext', () => {
  it('same-origin path はそのまま返る', () => {
    expect(sanitizeRelativeNext('/minutes/new/manual?template_id=x')).toBe(
      '/minutes/new/manual?template_id=x',
    )
  })

  it('"/" 単体もそのまま返る', () => {
    expect(sanitizeRelativeNext('/')).toBe('/')
  })

  it('protocol-relative URL（//evil.com）は null', () => {
    expect(sanitizeRelativeNext('//evil.com')).toBeNull()
  })

  it('バックスラッシュ変種（/\\evil）は null', () => {
    expect(sanitizeRelativeNext('/\\evil')).toBeNull()
  })

  it('絶対 URL（https://evil.com）は null', () => {
    expect(sanitizeRelativeNext('https://evil.com')).toBeNull()
  })

  it('"/" で始まらない相対パスは null', () => {
    expect(sanitizeRelativeNext('minutes/new')).toBeNull()
  })

  it('null は null', () => {
    expect(sanitizeRelativeNext(null)).toBeNull()
  })

  it('undefined は null', () => {
    expect(sanitizeRelativeNext(undefined)).toBeNull()
  })

  it('空文字は null', () => {
    expect(sanitizeRelativeNext('')).toBeNull()
  })

  it('制御文字混入は null', () => {
    expect(sanitizeRelativeNext('/minutes\x00new')).toBeNull()
    expect(sanitizeRelativeNext('/minutes\nnew')).toBeNull()
  })
})
