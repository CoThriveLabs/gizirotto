/**
 * フォーム途中入力の localStorage キャッシュ純関数群。
 * 未認証で送信 → /login 経由復帰した際に入力値を復元するため。
 *
 * localStorage を使う理由: magic link 認証はメールクライアントが新しいタブでリンクを開くため、
 * タブ単位で完全独立な sessionStorage では元タブの下書きを参照できない。同一ブラウザ内であれば
 * タブをまたいで共有できる localStorage が必要（別端末間の引き継ぎは対象外）。
 *
 * 設計判断:
 *   - キー名前空間: `form-cache:v1:<formId>` で他 localStorage キーと完全分離
 *   - TTL: 5 分（magic link 認証時間に十分・期限切れ放置値の復元防止）
 *   - expectedPath: 比較は呼出側（hook）で行う。純関数は TTL 判定のみ
 *   - File / Blob はキャッシュ不可（5MB 上限超過 + 機微情報リスク）
 *   - 機微情報（password / token / クレジット系）はキャッシュ対象外
 *
 * 純関数: DOM/React 非依存。unit テスト対象。
 */

export const FORM_CACHE_KEY_PREFIX = 'form-cache:v1:'
export const FORM_CACHE_DEFAULT_TTL_MS = 5 * 60 * 1000
/** ゲスト系 snapshot（save-draft 等）の TTL。magic-link 認証往復に十分な 30 分。 */
export const GUEST_SNAPSHOT_TTL_MS = 30 * 60 * 1000

export type FormCacheEntry<T> = {
  savedAt: number
  expectedPath: string
  values: T
}

/**
 * Web Storage の最小インターフェース（sessionStorage / localStorage 互換）。
 * テストで in-memory モックを差し込めるよう構造的部分型で受ける。
 * length / key はキー列挙が必要な処理（sweepExpiredFormCache）向けのオプショナル拡張。
 */
export interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  length?: number
  key?(index: number): string | null
}

/**
 * SSR / Node サーバ実行時に typeof globalThis === 'undefined' で安全に no-op するための
 * 取得ヘルパ。クライアント JS 実行時のみ localStorage を返す。
 */
export function getDraftStorageSafe(): DraftStorage | null {
  if (typeof globalThis === 'undefined') return null
  const g = globalThis as { localStorage?: DraftStorage }
  return g.localStorage ?? null
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

/**
 * form-cache 名前空間（`form-cache:v1:`）配下の期限切れエントリを一括削除する。
 * localStorage は sessionStorage と違いタブを閉じても残るため、TTL 切れの放置値が
 * 溜まり続けるのを防ぐガベージコレクション用途。
 *
 * ttlMs は名前空間全体に一律適用する単一の閾値であり、formId ごとの個別 TTL（例:
 * save-draft の 30 分 vs 通常フォームの 5 分）は判定しない。個別 TTL の正確な判定は
 * 各呼出元の readFormCache(storage, formId, 個別ttlMs) に委ねる — sweep は物理残留を
 * 防ぐための粗い掃除に徹する。呼出側は名前空間内で最大の TTL（既定は GUEST_SNAPSHOT_TTL_MS）
 * を渡すこと。短い ttlMs を渡すと、まだ有効期限内の長寿命エントリ（30 分 TTL の save-draft 等）を
 * readFormCache に読まれる前に誤って削除してしまう（認証メールのリンクで戻る前に下書きが消える事故）。
 *
 * length / key を持たない storage（列挙不可）・storage === null では no-op。
 * パース失敗・savedAt 欠損などの壊れ値も防御的に削除対象へ含める。
 */
export function sweepExpiredFormCache(
  storage: DraftStorage | null,
  ttlMs: number = FORM_CACHE_DEFAULT_TTL_MS,
  now: number = Date.now(),
): void {
  if (!storage) return
  if (typeof storage.length !== 'number' || typeof storage.key !== 'function') return

  const keysToRemove: string[] = []
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (!key || !key.startsWith(FORM_CACHE_KEY_PREFIX)) continue
    const raw = storage.getItem(key)
    if (!raw) {
      keysToRemove.push(key)
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      keysToRemove.push(key)
      continue
    }
    if (!parsed || typeof parsed !== 'object') {
      keysToRemove.push(key)
      continue
    }
    const savedAt = (parsed as Record<string, unknown>).savedAt
    if (typeof savedAt !== 'number' || savedAt + ttlMs < now) {
      keysToRemove.push(key)
    }
  }

  for (const key of keysToRemove) {
    safeRemove(storage, key)
  }
}

function safeRemove(storage: DraftStorage, key: string): void {
  try {
    storage.removeItem(key)
  } catch {
    // no-op
  }
}
