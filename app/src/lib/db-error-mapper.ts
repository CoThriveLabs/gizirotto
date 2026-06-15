/**
 * DB エラー → API 応答マッピング。
 * family_resource_limit (P0001 + hint) を 429 RESOURCE_LIMIT_EXCEEDED にマップする。
 *
 * 用途:
 *  - API route 経路: `mapDbErrorToResourceLimit` で 429 Response 用の body/status を組み立て
 *  - Server Action 経路: `ResourceLimitError` を throw してクライアント側で modal 出し分け
 *    (Next.js Server Action は HTTP 429 を直接返せないため)
 *
 * 注意: error.message は本番でもクライアントに返さない（情報漏洩対策）。
 *      上限到達という事実と resource 種別のみ返し、内部 cap 値は body に含めない。
 */

/**
 * Server Action 経路の専用エラー型。
 *
 * Server Action は HTTP 429 を直接返せず Error throw → クライアント catch でしか
 * 上限到達を表現できない。`ResourceLimitError` を専用クラスとして導入することで、
 * クライアント側で `e instanceof ResourceLimitError` での型安全な判定が可能になる。
 *
 * scope は常に 'family' (リソース上限は family_limits 由来)。
 *
 * 注意: message は固定の 'RESOURCE_LIMIT_EXCEEDED' (sentinel) で、ユーザー向け文言は
 *      クライアント側で resource を見て組み立てる（情報漏洩対策）。
 */
export class ResourceLimitError extends Error {
  resource: 'minutes' | 'templates'
  scope: 'family'
  constructor(resource: 'minutes' | 'templates') {
    super('RESOURCE_LIMIT_EXCEEDED')
    this.name = 'ResourceLimitError'
    this.resource = resource
    this.scope = 'family'
  }
}

export interface DbErrorLike {
  code?: string | null
  message?: string | null
  details?: string | null
  hint?: string | null
}

export interface ResourceLimitResponse {
  status: 429
  body: {
    error: string
    code: 'RESOURCE_LIMIT_EXCEEDED'
    resource: 'minutes' | 'templates'
  }
}

/**
 * DB エラーがリソース上限トリガ由来なら ResourceLimitResponse を返す。
 * それ以外は null (caller 側で既存のエラーハンドリングに委ねる)。
 *
 * 判定: errcode='P0001' AND hint='family_resource_limit' (migration #4 の raise exception 仕様)
 *      message に '議事録' / 'テンプレ' が含まれるかで resource 種別を分岐。
 */
export function mapDbErrorToResourceLimit(
  error: DbErrorLike | null | undefined,
): ResourceLimitResponse | null {
  if (!error) return null
  if (error.code !== 'P0001') return null
  if (error.hint !== 'family_resource_limit') return null

  const msg = error.message ?? ''
  // DB trigger の raise exception 文言で分岐。
  // 議事録: '議事録の今月上限（N）に達しました'
  // テンプレ: 'テンプレ累積上限（N）に達しました'
  const resource: 'minutes' | 'templates' = msg.includes('議事録')
    ? 'minutes'
    : 'templates'

  return {
    status: 429,
    body: {
      // クライアント表示は code + resource で出し分け (cap 値リーク回避)
      error: '家族の上限に達しました',
      code: 'RESOURCE_LIMIT_EXCEEDED',
      resource,
    },
  }
}
