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

  it('非正規化パス（/..//evil.com）は正規化すると // で始まるため null', () => {
    expect(sanitizeRelativeNext('/..//evil.com')).toBeNull()
  })

  it('親ディレクトリ参照はルート基準に正規化して返す', () => {
    expect(sanitizeRelativeNext('/../../minutes')).toBe('/minutes')
    expect(sanitizeRelativeNext('/minutes/../templates')).toBe('/templates')
  })

  it('カレント参照・重複セグメントも正規化される', () => {
    expect(sanitizeRelativeNext('/minutes/./new')).toBe('/minutes/new')
  })

  it('query / hash は正規化後も保持される', () => {
    expect(sanitizeRelativeNext('/minutes/../templates?a=1#frag')).toBe(
      '/templates?a=1#frag',
    )
  })
})
