/**
 * touchGuestAdjustDraft — 家族未作成ユーザーを /family/setup へ寄り道させる直前に
 * ゲスト下書きの TTL（savedAt）を打ち直す純関数のテスト。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFormCache, makeFormCacheKey, GUEST_SNAPSHOT_TTL_MS } from '@/lib/utils/form-cache'
import { guestAdjustDraftFormId, touchGuestAdjustDraft } from '@/lib/utils/guest-adjust-draft'

const TID = '00000000-0000-0000-0000-000000000003'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
})

describe('touchGuestAdjustDraft', () => {
  it('既存エントリの savedAt が更新され、values / expectedPath は不変', () => {
    const formId = guestAdjustDraftFormId(TID)
    const values = { templateId: TID, title: 't', meetingDate: '2026-08-01', content: {}, overrides: {} }
    const OLD_SAVED_AT = Date.now() - 20 * 60 * 1000
    writeFormCache(localStorage, formId, values, '/minutes/new/manual', OLD_SAVED_AT)

    touchGuestAdjustDraft(TID)

    const raw = localStorage.getItem(makeFormCacheKey(formId))
    expect(raw).not.toBeNull()
    const entry = JSON.parse(raw!) as { savedAt: number; expectedPath: string; values: unknown }
    expect(entry.savedAt).toBeGreaterThan(OLD_SAVED_AT)
    expect(entry.expectedPath).toBe('/minutes/new/manual')
    expect(entry.values).toEqual(values)
  })

  it('エントリが無ければ no-op（新規作成しない）', () => {
    touchGuestAdjustDraft(TID)
    expect(localStorage.getItem(makeFormCacheKey(guestAdjustDraftFormId(TID)))).toBeNull()
  })

  it('期限切れエントリ（30 分超過）は no-op のまま（打ち直さず消えている）', () => {
    const formId = guestAdjustDraftFormId(TID)
    const EXPIRED_SAVED_AT = Date.now() - GUEST_SNAPSHOT_TTL_MS - 1000
    writeFormCache(localStorage, formId, { v: 1 }, '/minutes/new/manual', EXPIRED_SAVED_AT)

    touchGuestAdjustDraft(TID)

    // readFormCache が TTL 判定で自動 removeItem するため、打ち直されず消えたままになる。
    expect(localStorage.getItem(makeFormCacheKey(formId))).toBeNull()
  })
})
