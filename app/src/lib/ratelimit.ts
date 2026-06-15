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
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'

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
