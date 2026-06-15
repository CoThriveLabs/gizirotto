import { NextResponse } from 'next/server'

/**
 * API エラーレスポンスの共通ヘルパー。
 *
 * 本番環境で `detail: err.message` がそのまま JSON に乗り、
 * stack trace / 内部ファイルパス / SQL 文字列等が外部にリークする問題を共通化して塞ぐ。
 *
 * - 本番（NODE_ENV === 'production'）: `{ error }` のみを返す。
 * - 非本番（development / test / preview）: `{ error, detail }` で従来通り詳細を返す（DX 維持）。
 * - サーバー側ログ（console.error）には常に raw error を残し、Vercel logs で調査可能にする。
 */
export function errorResponse(
  message: string,
  status: number,
  err?: unknown,
  extraFields?: Record<string, unknown>,
): NextResponse {
  if (err) {
    console.error('[API error]', message, err)
  }
  const body: Record<string, unknown> = { error: message, ...(extraFields ?? {}) }
  if (process.env.NODE_ENV !== 'production' && err instanceof Error) {
    body.detail = err.message
  }
  return NextResponse.json(body, { status })
}

/**
 * SSE ストリーム用エラーイベントのペイロード生成。
 *
 * SSE 経路（format-item, chat/stream）は NextResponse.json ではなく
 * `data: {...}\n\n` 形式で error イベントを流す必要があるため、
 * NextResponse 系の errorResponse() とは別の helper として提供する。
 *
 * 戻り値はそのまま `data: ${JSON.stringify(payload)}\n\n` の `payload` として利用。
 */
export function formatSseErrorPayload(
  err: unknown,
  fallback = 'unknown',
): { type: 'error'; message: string } {
  if (err) {
    console.error('[SSE error]', err)
  }
  if (process.env.NODE_ENV !== 'production' && err instanceof Error) {
    return { type: 'error', message: err.message }
  }
  return { type: 'error', message: fallback }
}
