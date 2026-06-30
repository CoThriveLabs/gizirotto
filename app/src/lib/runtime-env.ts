import 'server-only'

// Determines whether the code is running in a Vercel production deployment.
// Uses VERCEL_ENV when set by the Vercel platform (most accurate).
// Falls back to NODE_ENV only when VERCEL=1 confirms a Vercel environment,
// so that local `next build` (NODE_ENV=production, VERCEL unset) is not
// mistakenly treated as production and does not crash on missing Upstash env.
export function resolveIsProduction(env: {
  VERCEL_ENV?: string
  NODE_ENV?: string
  VERCEL?: string
}): boolean {
  if (env.VERCEL_ENV !== undefined) return env.VERCEL_ENV === 'production'
  // Without VERCEL_ENV, only trust NODE_ENV when we are actually on Vercel.
  if (env.VERCEL === '1') return env.NODE_ENV === 'production'
  return false
}

export function isProductionRuntime(): boolean {
  return resolveIsProduction(process.env)
}
