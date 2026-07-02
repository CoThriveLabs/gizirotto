/**
 * ゲスト AdjustView の form-cache 橋渡しキー / 復元先パスの単一ソース。
 * GuestAdjustBootstrap（保存側）と ManualBootstrap（復元側）の両方から参照し、
 * 文字列のハードコード不一致による復元スキップ事故を防ぐ。
 */
export function guestAdjustDraftFormId(templateId: string): string {
  return `minutes:new:adjust:${templateId}`
}

/** ログイン後、draft を復元して本保存する着地ページの pathname。form-cache の expectedPath と一致させる。 */
export const GUEST_ADJUST_DRAFT_RESTORE_PATH = '/minutes/new/manual'

/**
 * chat-draft（ChatView がゲスト finalize 時に書く AI 抽出済み content）の form-cache 橋渡しキー。
 * ChatView（保存側）と GuestAdjustBootstrap（復元側）の両方から参照する。
 */
export function guestChatDraftFormId(templateId: string): string {
  return `minutes:guest-chat-draft:${templateId}`
}

/** chat-draft の復元先（同一タブ内で即遷移する AdjustView 到達ルート）。form-cache の expectedPath と一致させる。 */
export const GUEST_CHAT_DRAFT_RESTORE_PATH = '/minutes/new/adjust'

/**
 * chat-draft の TTL。ChatView finalize → GuestAdjustBootstrap mount は同一タブ内の即時遷移のため
 * 通常は数秒〜数分で消費される。ブラウザの戻る操作や再読み込みの余裕を見て 10 分に設定。
 */
export const GUEST_CHAT_DRAFT_TTL_MS = 10 * 60 * 1000
