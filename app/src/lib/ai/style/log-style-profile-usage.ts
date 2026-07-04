import { logAiUsage } from '@/lib/ai-usage-guard'
import type { BuildStyleProfileResult } from './build-style-profile'

/**
 * buildStyleProfile の結果から AI 利用量ログを記録する（best-effort）。
 * NO_MINUTES / EMPTY_CONTENT は Anthropic 未呼出のためログ対象外。
 * regenerateStyleProfile（手動再生成）と maybeTriggerStyleProfile（初回自動生成）の
 * 両方から共通で使う。
 */
export async function logStyleProfileUsage(
  result: BuildStyleProfileResult,
  params: { familyId: string; userId: string },
): Promise<void> {
  const calledAi =
    result.skippedReason !== 'NO_MINUTES' && result.skippedReason !== 'EMPTY_CONTENT'
  if (!calledAi) return

  const inputTokens = result.usage?.inputTokens ?? 0
  const outputTokens = result.usage?.outputTokens ?? 0
  // Claude Haiku 3.5 estimate: input $3 / output $15 per 1M tokens.
  const cost = (inputTokens * 3 + outputTokens * 15) / 1_000_000
  await logAiUsage({
    familyId: params.familyId,
    userId: params.userId,
    endpoint: 'style-profile',
    inputTokens,
    outputTokens,
    costUsdEstimate: cost,
  })
}
