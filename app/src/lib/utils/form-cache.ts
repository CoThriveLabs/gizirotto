/**
 * フォーム途中入力の sessionStorage キャッシュ純関数群。
 * 未認証で送信 → /login 経由復帰した際に入力値を復元するため。
 *
 * 設計判断:
 *   - キー名前空間: `form-cache:v1:<formId>` で他 sessionStorage キーと完全分離
 *   - TTL: 5 分（magic link 認証時間に十分・期限切れ放置値の復元防止）
 *   - expectedPath: 比較は呼出側（hook）で行う。純関数は TTL 判定のみ
 *   - File / Blob はキャッシュ不可（5MB 上限超過 + 機微情報リスク）
 *   - 機微情報（password / token / クレジット系）はキャッシュ対象外
 *
 * 純関数: DOM/React 非依存。unit テスト対象。
 */

export const FORM_CACHE_KEY_PREFIX = 'form-cache:v1:'
export const FORM_CACHE_DEFAULT_TTL_MS = 5 * 60 * 1000

export type FormCacheEntry<T> = {
  savedAt: number
  expectedPath: string
  values: T
}

/**
 * Web Storage の最小インターフェース（sessionStorage / localStorage 互換）。
 * テストで in-memory モックを差し込めるよう構造的部分型で受ける。
 */
export interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * SSR / Node サーバ実行時に typeof sessionStorage === 'undefined' で安全に no-op するための
 * 取得ヘルパ。クライアント JS 実行時のみ sessionStorage を返す。
 */
export function getSessionStorageSafe(): DraftStorage | null {
  if (typeof globalThis === 'undefined') return null
  const g = globalThis as { sessionStorage?: DraftStorage }
  return g.sessionStorage ?? null
}

export function makeFormCacheKey(formId: string): string {
  return `${FORM_CACHE_KEY_PREFIX}${formId}`
}

/**
 * snapshot を読み出して TTL 判定。不正値・期限切れは null 返却 + 自動 removeItem。
 *
 * 厳格チェック:
 *   - JSON.parse 失敗 → null + remove
 *   - savedAt / expectedPath / values の欠損 → null + remove
 *   - TTL 超過 → null + remove
 *
 * expectedPath の比較は呼出側で行う（純関数は path コンテキストを持たない）。
 */
export function readFormCache<T>(
  storage: DraftStorage | null,
  formId: string,
  ttlMs: number = FORM_CACHE_DEFAULT_TTL_MS,
  now: number = Date.now(),
): FormCacheEntry<T> | null {
  if (!storage) return null
  const key = makeFormCacheKey(formId)
  const raw = storage.getItem(key)
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    safeRemove(storage, key)
    return null
  }
  if (!parsed || typeof parsed !== 'object') {
    safeRemove(storage, key)
    return null
  }
  const obj = parsed as Record<string, unknown>
  const savedAt = typeof obj.savedAt === 'number' ? obj.savedAt : null
  const expectedPath =
    typeof obj.expectedPath === 'string' ? obj.expectedPath : null
  if (savedAt == null || expectedPath == null || !('values' in obj)) {
    safeRemove(storage, key)
    return null
  }
  if (savedAt + ttlMs < now) {
    safeRemove(storage, key)
    return null
  }
  return {
    savedAt,
    expectedPath,
    values: obj.values as T,
  }
}

/**
 * snapshot を書き込む。storage が null（SSR）なら no-op。
 * 容量超過 / SecurityError は握り潰し（snapshot 永続化失敗は致命でない）。
 */
export function writeFormCache<T>(
  storage: DraftStorage | null,
  formId: string,
  values: T,
  expectedPath: string,
  now: number = Date.now(),
): void {
  if (!storage) return
  const entry: FormCacheEntry<T> = { savedAt: now, expectedPath, values }
  try {
    storage.setItem(makeFormCacheKey(formId), JSON.stringify(entry))
  } catch {
    // 容量超過・SecurityError は握り潰す（minutes-adjust-draft.ts と同パターン）
  }
}

/**
 * snapshot を破棄する。復元成功後 / 送信成功後に呼ぶ。
 */
export function clearFormCache(
  storage: DraftStorage | null,
  formId: string,
): void {
  if (!storage) return
  safeRemove(storage, makeFormCacheKey(formId))
}

function safeRemove(storage: DraftStorage, key: string): void {
  try {
    storage.removeItem(key)
  } catch {
    // no-op
  }
}
