/**
 * 自分記入モードの「ID なしドラフト持ち回り」用の sessionStorage アダプタ純関数群。
 * AdjustView と直行ルートの両方から共通で使い、key 不一致や parse バグを 1 箇所に閉じる。
 *
 * lazy create 方針:
 *   - 編集画面に入っただけでは createMinute しない（空 minutes 量産ゼロ）。
 *   - 最初の値入力 or 「保存」押下のタイミングで createMinute(content + overrides) 実行。
 *   - それまでは sessionStorage に `{templateId, values, overrides}` を持ち回る。
 *
 * 設計判断:
 *   - 既存 ManualForm 経路の `minutes:draft` キー（A-1/A-2/B-2 confirm 向け）と**衝突回避**のため
 *     `minutes:adjust-draft` 別キーで持つ。confirm 画面の `minutes:draft` 取り違えを防ぐ。
 *   - storage は引数で受け取り（jsdom テスト容易・SSR 安全・サーバ実行時は no-op）。
 *   - 不正 JSON / 部分欠損は読み出し時に null を返す（呼出側で「空 draft からやり直し」できる）。
 *
 * 純関数: DOM/React 非依存。unit テスト対象。
 */

/** sessionStorage キー。既存 `minutes:draft` とは独立（confirm 経路と非衝突）。 */
export const MINUTES_ADJUST_DRAFT_KEY = 'minutes:adjust-draft'

/**
 * 段階 3 B のドラフト形（sessionStorage 持ち回りデータ）。
 * - templateId: 必須（テンプレ選択直後に確定）。
 * - values: 値マップ（空 string も含めて全 field をキーで持つ）。
 * - overrides: bbox_overrides 相当 partial（§3-2）。空 {} もあり得る。
 */
export type ManualAdjustDraft = {
  templateId: string
  values: Record<string, string>
  overrides: Record<string, unknown>
}

/**
 * Web Storage の最小インターフェース（sessionStorage / localStorage 互換・jsdom 互換）。
 * テストで in-memory モックを差し込めるよう構造的部分型で受ける。
 */
export interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * SSR / Node サーバ実行時に typeof sessionStorage === 'undefined' で安全に no-op するための
 * 取得ヘルパ。クライアント JS 実行時のみ sessionStorage を返す（呼出側でガードしてもよい）。
 */
export function getSessionStorageSafe(): DraftStorage | null {
  if (typeof globalThis === 'undefined') return null
  const g = globalThis as { sessionStorage?: DraftStorage }
  return g.sessionStorage ?? null
}

/**
 * draft を読み出して正規化（不正値は null 返却）。
 *
 * 厳格チェック:
 *   - JSON.parse 失敗 → null
 *   - templateId が string でない → null（lazy create に必須）
 *   - values が object でない → null
 *   - overrides が object でない → 空オブジェクトに正規化（位置情報は無くてもよい）
 *
 * values の各値は型ガードで string のみ採用、それ以外は空文字へフォールバック。
 */
export function readManualAdjustDraft(
  storage: DraftStorage | null,
): ManualAdjustDraft | null {
  if (!storage) return null
  const raw = storage.getItem(MINUTES_ADJUST_DRAFT_KEY)
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  const templateId = typeof obj.templateId === 'string' ? obj.templateId : null
  if (!templateId) return null
  const valuesRaw =
    obj.values && typeof obj.values === 'object'
      ? (obj.values as Record<string, unknown>)
      : null
  if (!valuesRaw) return null
  const values: Record<string, string> = {}
  for (const [k, v] of Object.entries(valuesRaw)) {
    values[k] = typeof v === 'string' ? v : v == null ? '' : String(v)
  }
  const overridesRaw =
    obj.overrides && typeof obj.overrides === 'object'
      ? (obj.overrides as Record<string, unknown>)
      : {}
  return { templateId, values, overrides: overridesRaw }
}

/**
 * draft を書き込む。storage が null（SSR）なら no-op。
 * JSON.stringify 失敗は呼出側ではほぼ起き得ないが、防御的に try でラップ。
 */
export function writeManualAdjustDraft(
  storage: DraftStorage | null,
  draft: ManualAdjustDraft,
): void {
  if (!storage) return
  try {
    storage.setItem(MINUTES_ADJUST_DRAFT_KEY, JSON.stringify(draft))
  } catch {
    // 容量超過や iframe 経由の SecurityError などは握り潰す。draft 永続化失敗は
    // 「ブラウザを閉じたら消える」と同じ扱いで、UX 上は致命ではない。
  }
}

/**
 * draft を破棄する。lazy create 成功直後 / 明示「キャンセル」操作で呼ぶ。
 * storage が null なら no-op。
 */
export function clearManualAdjustDraft(storage: DraftStorage | null): void {
  if (!storage) return
  try {
    storage.removeItem(MINUTES_ADJUST_DRAFT_KEY)
  } catch {
    // no-op
  }
}

/**
 * 空 draft（テンプレ選択直後の初期値）。fields の name から空文字のマップを生成する。
 *
 * 用途: 直行ルートで templateId と field 名一覧から「全 field 空文字」の初期 draft を組む。
 * これを `writeManualAdjustDraft` で sessionStorage に置いておけば、AdjustView は draft 読出だけで
 * 統一的に動ける（initialValues prop と互換）。
 */
export function emptyManualAdjustDraft(
  templateId: string,
  fieldNames: string[],
): ManualAdjustDraft {
  return {
    templateId,
    values: Object.fromEntries(fieldNames.map((n) => [n, ''])),
    overrides: {},
  }
}
