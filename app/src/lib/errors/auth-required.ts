/**
 * server action / fetch から AUTH エラーを型安全に判定するためのカスタムエラークラス。
 * 既存 `lib/db-error-mapper.ts` の `ResourceLimitError` と同パターン。
 *
 * 用途:
 *   - server action 内で「未認証時に throw する標準型」として使う
 *   - クライアント側 catch で `isAuthRequiredError(e)` 判定 → form-cache snapshot 保存 +
 *     `/login?next=<元URL>` 遷移へ流す
 *
 * 互換: 既存のいくつかの server action 経路では Error('UNAUTHENTICATED') を投げているため、
 *      isAuthRequiredError は 'AUTH_REQUIRED' / 'UNAUTHENTICATED' の両方を許容する。
 */

export class AuthRequiredError extends Error {
  readonly name = 'AuthRequiredError'
  constructor(message = 'AUTH_REQUIRED') {
    super(message)
  }
}

export function isAuthRequiredError(e: unknown): boolean {
  if (e instanceof AuthRequiredError) return true
  if (e instanceof Error) {
    return (
      e.name === 'AuthRequiredError' ||
      e.message === 'AUTH_REQUIRED' ||
      e.message === 'UNAUTHENTICATED'
    )
  }
  return false
}
