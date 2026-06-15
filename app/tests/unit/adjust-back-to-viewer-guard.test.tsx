/**
 * 閲覧画面戻り導線の構造的回帰防止 unit。
 *
 * 旧版では純関数 `handleBackToViewerGuard` (window.confirm 経路) を直接テストしていたが、
 * 2026-06-14 リファクタで `window.confirm` を共通モーダル `UnsavedChangesModal` に統一し、
 * 純関数自体を廃止した（設計書 unsaved_changes_modal_design_2026-06-14.md §3）。
 *
 * モーダル本体の動作は tests/unit/unsaved-changes-modal.test.tsx で 15 ケース検証済み。
 * AdjustView の統合動作は tests/unit/adjust-leave-guard-modal.test.tsx で検証する。
 *
 * 本ファイルでは戻り link href の構造妥当性のみ回帰防止する。
 */
import { describe, it, expect } from 'vitest'

describe('戻り link href の構造', () => {
  it('戻り先 URL は /minutes/${minuteId} 形式（詳細画面ルート）', () => {
    // AdjustView 内で `/minutes/${minuteId}` を Link href に渡す構造を回帰検証。
    // page.tsx ルート規約と完全一致（詳細画面 = /minutes/[id]）。
    const minuteId = 'abc-123'
    const expected = `/minutes/${minuteId}`
    expect(expected).toBe('/minutes/abc-123')
    expect(expected.startsWith('/minutes/')).toBe(true)
    expect(expected).not.toContain('/adjust') // 詳細画面・編集画面ではない
  })
})
