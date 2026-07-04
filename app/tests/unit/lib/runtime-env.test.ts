import { describe, it, expect } from 'vitest'
import { resolveIsProduction } from '@/lib/runtime-env'

describe('resolveIsProduction', () => {
  describe('when VERCEL_ENV is set', () => {
    it('returns true when VERCEL_ENV is "production"', () => {
      expect(resolveIsProduction({ VERCEL_ENV: 'production' })).toBe(true)
    })

    it('returns false when VERCEL_ENV is "preview"', () => {
      expect(resolveIsProduction({ VERCEL_ENV: 'preview' })).toBe(false)
    })

    it('returns false when VERCEL_ENV is "development"', () => {
      expect(resolveIsProduction({ VERCEL_ENV: 'development' })).toBe(false)
    })

    it('ignores NODE_ENV when VERCEL_ENV is set', () => {
      // VERCEL_ENV takes precedence; NODE_ENV=production should not matter
      expect(resolveIsProduction({ VERCEL_ENV: 'preview', NODE_ENV: 'production' })).toBe(false)
    })
  })

  describe('when VERCEL_ENV is not set', () => {
    it('returns false when NODE_ENV is "production" but VERCEL is not set (local build)', () => {
      // Local `next build` sets NODE_ENV=production but VERCEL is unset.
      // We must not treat this as production to avoid crashing on missing Upstash env.
      expect(resolveIsProduction({ NODE_ENV: 'production' })).toBe(false)
    })

    it('returns true when VERCEL=1 and NODE_ENV is "production"', () => {
      // Actual Vercel deployment without VERCEL_ENV set (edge case)
      expect(resolveIsProduction({ VERCEL: '1', NODE_ENV: 'production' })).toBe(true)
    })

    it('returns false when NODE_ENV is "development"', () => {
      expect(resolveIsProduction({ NODE_ENV: 'development' })).toBe(false)
    })

    it('returns false when NODE_ENV is "test"', () => {
      expect(resolveIsProduction({ NODE_ENV: 'test' })).toBe(false)
    })

    it('returns false when both are undefined', () => {
      expect(resolveIsProduction({})).toBe(false)
    })
  })
})
