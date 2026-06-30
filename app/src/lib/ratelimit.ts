/**
 * Upstash ratelimit 実体化 + middleware 統合。
 *
 * このファイルは「サーバ専用」(Redis.fromEnv を呼ぶ)。
 * クライアントから import しないこと (mistake.md「サーバ専用 × クライアント純関数同居」禁則)。
 *
 * env (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN) 未設定環境
 * (ローカル / CI) では noop に退避し、既存挙動 (常に success) を壊さない。
 */

import 'server-only'
import { Ratelimit, type Duration } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { isProductionRuntime } from '@/lib/runtime-env'

export interface RateLimitResult {
  success: boolean
  reset: number // epoch ms
  remaining: number
}

export interface RateLimiter {
  limit(key: string): Promise<RateLimitResult>
}

function hasUpstashEnv(): boolean {
  return (
    !!process.env.UPSTASH_REDIS_REST_URL &&
    !!process.env.UPSTASH_REDIS_REST_TOKEN
  )
}

// Fail closed in production: a missing rate-limit backend must crash on boot,
// not silently fall back to a pass-through limiter.
if (isProductionRuntime() && !hasUpstashEnv()) {
  throw new Error('RATELIMIT_MISCONFIGURED: Upstash REST env vars are required in production')
}

if (!hasUpstashEnv()) {
  console.info({ msg: 'rate limiting disabled (non-production)' })
}

const noop: RateLimiter = {
  async limit() {
    return { success: true, reset: Date.now() + 10_000, remaining: 10 }
  },
}

function buildUpstashLimiter(): RateLimiter {
  const redis = Redis.fromEnv()
  const rl = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(10, '10 s'),
    analytics: false, // cmd 消費抑制 (500K/月 枠温存)
    prefix: 'minutes:burst',
  })
  return {
    async limit(key: string) {
      const r = await rl.limit(key)
      return { success: r.success, reset: r.reset, remaining: r.remaining }
    },
  }
}

export const ipBurstLimit: RateLimiter = hasUpstashEnv()
  ? buildUpstashLimiter()
  : noop

const GUEST_AI_LIMIT_COUNT = Number(process.env.GUEST_AI_LIMIT_COUNT ?? '2')
// Cast is safe: env value must follow Upstash Duration syntax (e.g. "90 d", "1 h").
const GUEST_AI_LIMIT_WINDOW = (process.env.GUEST_AI_LIMIT_WINDOW ?? '90 d') as Duration

function buildGuestAiLimiter(): RateLimiter {
  const redis = Redis.fromEnv()
  const rl = new Ratelimit({
    redis,
    // Sliding window preserves count over the full window even if requests trickle in.
    limiter: Ratelimit.slidingWindow(GUEST_AI_LIMIT_COUNT, GUEST_AI_LIMIT_WINDOW),
    analytics: false,
    prefix: 'minutes:guest-ai',
  })
  return {
    async limit(key: string) {
      const r = await rl.limit(key)
      return { success: r.success, reset: r.reset, remaining: r.remaining }
    },
  }
}

/**
 * Per-IP cumulative gate for unauthenticated AI requests.
 * Default: 2 calls per 90 days (configurable via GUEST_AI_LIMIT_COUNT / GUEST_AI_LIMIT_WINDOW).
 * When Upstash env vars are absent (local / CI) this resolves to a noop that always succeeds.
 */
export const guestAiLimit: RateLimiter = hasUpstashEnv()
  ? buildGuestAiLimiter()
  : noop

const GUEST_TEMPLATE_LIMIT_COUNT = Number(process.env.GUEST_TEMPLATE_LIMIT_COUNT ?? '2')
// Cast is safe: env value must follow Upstash Duration syntax (e.g. "90 d", "1 h").
const GUEST_TEMPLATE_LIMIT_WINDOW = (process.env.GUEST_TEMPLATE_LIMIT_WINDOW ?? '90 d') as Duration

function buildGuestTemplateLimiter(): RateLimiter {
  const redis = Redis.fromEnv()
  const rl = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(GUEST_TEMPLATE_LIMIT_COUNT, GUEST_TEMPLATE_LIMIT_WINDOW),
    analytics: false,
    prefix: 'minutes:guest-template',
  })
  return {
    async limit(key: string) {
      const r = await rl.limit(key)
      return { success: r.success, reset: r.reset, remaining: r.remaining }
    },
  }
}

/**
 * Per-IP cumulative gate for unauthenticated template-preview requests.
 * Default: 2 calls per 90 days (configurable via GUEST_TEMPLATE_LIMIT_COUNT / GUEST_TEMPLATE_LIMIT_WINDOW).
 * Key space is separate from guestAiLimit (prefix "minutes:guest-template").
 * When Upstash env vars are absent (local / CI) this resolves to a noop that always succeeds.
 */
export const guestTemplateLimit: RateLimiter = hasUpstashEnv()
  ? buildGuestTemplateLimiter()
  : noop
