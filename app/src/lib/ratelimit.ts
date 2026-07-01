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

// AI 呼び出し暴発防御専用（DoS 対策）。「議事録 2 件制限」は guestTemplateLimit で別途担保。
// 想定: 議事録 1 件で約 10 request（初回 kick + 会話 + extract-fields + format-item）× 2 件 = 20 request/日。
const GUEST_AI_DAILY_LIMIT_COUNT = Number(process.env.GUEST_AI_DAILY_LIMIT_COUNT ?? '20')
// Cast is safe: env value must follow Upstash Duration syntax (e.g. "1 d", "1 h").
const GUEST_AI_DAILY_LIMIT_WINDOW = (process.env.GUEST_AI_DAILY_LIMIT_WINDOW ?? '1 d') as Duration

function buildGuestAiDailyLimiter(): RateLimiter {
  const redis = Redis.fromEnv()
  const rl = new Ratelimit({
    redis,
    // Sliding window で 1 日ウィンドウを共有し、DoS 攻撃時の総 request 数を上限に抑える。
    limiter: Ratelimit.slidingWindow(GUEST_AI_DAILY_LIMIT_COUNT, GUEST_AI_DAILY_LIMIT_WINDOW),
    analytics: false,
    prefix: 'minutes:guest-ai-daily',
  })
  return {
    async limit(key: string) {
      const r = await rl.limit(key)
      return { success: r.success, reset: r.reset, remaining: r.remaining }
    },
  }
}

/**
 * 悪意 IP からの Anthropic API 呼び出し暴発防御。既定 20 req/1d/IP。
 * 「議事録 2 件制限」ではなく DoS 防御。通常ユーザーは 20 req/日で議事録 2 件を作り切れる想定。
 * Upstash 未設定環境（ローカル / CI）では noop。
 */
export const guestAiDailyLimit: RateLimiter = hasUpstashEnv()
  ? buildGuestAiDailyLimiter()
  : noop

const GUEST_TEMPLATE_LIMIT_COUNT = Number(process.env.GUEST_TEMPLATE_LIMIT_COUNT ?? '2')
// Cast is safe: env value must follow Upstash Duration syntax (e.g. "1 d", "1 h").
const GUEST_TEMPLATE_LIMIT_WINDOW = (process.env.GUEST_TEMPLATE_LIMIT_WINDOW ?? '1 d') as Duration

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
 * 「議事録 2 件制限」の唯一の担保。ゲストは 1 日 2 回まで AdjustView に到達できる。
 * `(public-flow)/minutes/new/adjust/page.tsx` で AdjustView 到達時に 1 回消費される。
 * 既定 2 回/1d/IP（GUEST_TEMPLATE_LIMIT_COUNT / GUEST_TEMPLATE_LIMIT_WINDOW で調整可）。
 * Key space は guestAiDailyLimit と独立（prefix "minutes:guest-template"）。
 * Upstash 未設定環境（ローカル / CI）では noop。
 */
export const guestTemplateLimit: RateLimiter = hasUpstashEnv()
  ? buildGuestTemplateLimiter()
  : noop
