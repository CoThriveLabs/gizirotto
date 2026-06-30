import 'server-only'

export async function recordGuestAiUsage(args: {
  endpoint: 'chat-stream' | 'format-item'
  inputTokens: number
  outputTokens: number
}): Promise<void> {
  // No-op when Upstash is not configured (local / CI).
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return

  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const key = `minutes:guest-ai:metrics:${today}`

  const prefix = `${args.endpoint}`

  // Batch HINCRBY calls in one HTTP round-trip via Upstash REST pipeline.
  // EXPIRE uses NX so TTL is only set on first write and never shortened.
  const pipeline = [
    ['HINCRBY', key, `${prefix}:count`, 1],
    ['HINCRBY', key, `${prefix}:inputTokens`, args.inputTokens],
    ['HINCRBY', key, `${prefix}:outputTokens`, args.outputTokens],
    ['EXPIRE', key, 60 * 60 * 24 * 35, 'NX'], // 35-day TTL, set only if not already present
  ]

  // Best-effort: errors are intentionally swallowed so metrics failures
  // do not affect the user-facing response.
  try {
    await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(pipeline),
    })
  } catch {
    // Intentionally swallowed.
  }
}
