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
