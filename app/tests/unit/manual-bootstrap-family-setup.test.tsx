/**
 * ManualBootstrap — needsFamilySetup=true（ログイン済みだが family 未参加）到達時の
 * バウンス挙動テスト。
 *
 * この分岐は createMinute を呼ばず /family/setup?next=... へ replace する。優先順位は
 * isGuest > needsFamilySetup（isGuest 分岐が先に return するため）。
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { writeFormCache, makeFormCacheKey, readFormCache } from '@/lib/utils/form-cache'
import { guestAdjustDraftFormId } from '@/lib/utils/guest-adjust-draft'

const replaceMock = vi.fn()
const createMinuteMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: replaceMock,
    refresh: vi.fn(),
    back: vi.fn(),
  }),
}))

vi.mock('@/server/minutes', () => ({
  createMinute: (...args: unknown[]) => createMinuteMock(...args),
  saveMinuteAdjust: vi.fn(),
}))

vi.mock('@/components/toast/toast-context', () => ({
  useToast: () => ({ showToast: vi.fn(), dismissToast: vi.fn(), toasts: [] }),
}))

import { ManualBootstrap } from '@/app/(dashboard)/minutes/new/manual/ManualBootstrap'

const TID = '00000000-0000-0000-0000-000000000002'

beforeEach(() => {
  replaceMock.mockReset()
  createMinuteMock.mockReset()
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
})

describe('ManualBootstrap — needsFamilySetup=true', () => {
  it('createMinute を呼ばず /family/setup?next=... （encode 済み）へ replace する', async () => {
    render(
      <ManualBootstrap
        templateId={TID}
        templateName="家族会議"
        fields={['議題', '決定事項']}
        needsFamilySetup
      />,
    )

    const expectedNext = encodeURIComponent(`/minutes/new/manual?template_id=${TID}`)
    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith(`/family/setup?next=${expectedNext}`)
    })
    expect(createMinuteMock).not.toHaveBeenCalled()
  })

  it('既存の下書きがあれば TTL（savedAt）を打ち直す（values/expectedPath は不変）', async () => {
    const formId = guestAdjustDraftFormId(TID)
    const values = { templateId: TID, title: 't', meetingDate: '2026-08-01', content: {}, overrides: {} }
    const OLD_SAVED_AT = Date.now() - 20 * 60 * 1000
    writeFormCache(localStorage, formId, values, '/minutes/new/manual', OLD_SAVED_AT)

    render(
      <ManualBootstrap
        templateId={TID}
        templateName="家族会議"
        fields={['議題', '決定事項']}
        needsFamilySetup
      />,
    )

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalled()
    })

    const raw = localStorage.getItem(makeFormCacheKey(formId))
    expect(raw).not.toBeNull()
    const entry = JSON.parse(raw!) as { savedAt: number; expectedPath: string; values: unknown }
    expect(entry.savedAt).toBeGreaterThan(OLD_SAVED_AT)
    expect(entry.expectedPath).toBe('/minutes/new/manual')
    expect(entry.values).toEqual(values)
  })

  it('下書きが無ければ新規作成しない（no-op）', async () => {
    render(
      <ManualBootstrap
        templateId={TID}
        templateName="家族会議"
        fields={['議題', '決定事項']}
        needsFamilySetup
      />,
    )

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalled()
    })
    expect(readFormCache(localStorage, guestAdjustDraftFormId(TID))).toBeNull()
  })

  it('isGuest=true が優先される（needsFamilySetup=true でもゲスト adjust ルートへ）', async () => {
    render(
      <ManualBootstrap
        templateId={TID}
        templateName="家族会議"
        fields={['議題', '決定事項']}
        isGuest
        needsFamilySetup
      />,
    )

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith(`/minutes/new/adjust?template_id=${TID}`)
    })
    expect(createMinuteMock).not.toHaveBeenCalled()
  })
})
