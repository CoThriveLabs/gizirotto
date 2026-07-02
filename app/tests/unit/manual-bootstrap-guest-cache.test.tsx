/**
 * ManualBootstrap — isGuest=true 到達時の遷移先 + ログイン後 draft 復元（form-cache 橋渡し）テスト。
 *
 * ゲスト（isGuest=true）はゲスト向け AdjustView 到達ルート（/minutes/new/adjust）へ即時遷移する。
 * ログイン後にこの画面へ戻ってきたときは、ゲスト時代の draft（form-cache）を復元して
 * createMinute + saveMinuteAdjust する橋渡しも行う。本ファイルはその両方の挙動を検証する。
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { writeFormCache, makeFormCacheKey } from '@/lib/utils/form-cache'
import {
  guestAdjustDraftFormId,
  GUEST_ADJUST_DRAFT_RESTORE_PATH,
} from '@/lib/utils/guest-adjust-draft'
import type { GuestMinuteDraft } from '@/app/(dashboard)/minutes/[id]/adjust/AdjustView'

const replaceMock = vi.fn()
const createMinuteMock = vi.fn()
const saveMinuteAdjustMock = vi.fn()

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
  saveMinuteAdjust: (...args: unknown[]) => saveMinuteAdjustMock(...args),
}))

vi.mock('@/components/toast/toast-context', () => ({
  useToast: () => ({ showToast: vi.fn(), dismissToast: vi.fn(), toasts: [] }),
}))

import { ManualBootstrap } from '@/app/(dashboard)/minutes/new/manual/ManualBootstrap'

const TID = '00000000-0000-0000-0000-000000000001'

beforeEach(() => {
  replaceMock.mockReset()
  createMinuteMock.mockReset()
  saveMinuteAdjustMock.mockReset()
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
})

describe('ManualBootstrap — isGuest=true', () => {
  it('ゲスト向け AdjustView 到達ルートへ即遷移する（createMinute は呼ばない）', async () => {
    render(
      <ManualBootstrap
        templateId={TID}
        templateName="家族会議"
        fields={['議題', '決定事項']}
        isGuest
      />,
    )
    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith(`/minutes/new/adjust?template_id=${TID}`)
    })
    expect(createMinuteMock).not.toHaveBeenCalled()
  })

  it('fields が空でも遷移先は変わらない', async () => {
    render(
      <ManualBootstrap
        templateId={TID}
        templateName="メモ用"
        fields={[]}
        isGuest
      />,
    )
    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith(`/minutes/new/adjust?template_id=${TID}`)
    })
  })
})

describe('ManualBootstrap — isGuest=false（ログイン後の本保存）', () => {
  it('draft が無い場合は既存の空 content フローが変わらない（回帰確認）', async () => {
    createMinuteMock.mockResolvedValue({ id: 'm-no-draft' })
    render(
      <ManualBootstrap
        templateId={TID}
        templateName="家族会議"
        fields={['議題', '決定事項']}
      />,
    )
    await waitFor(() => {
      expect(createMinuteMock).toHaveBeenCalledTimes(1)
    })
    const call = createMinuteMock.mock.calls[0][0]
    expect(call.templateId).toBe(TID)
    expect(call.title).toBe('家族会議')
    expect(call.content).toEqual({ 議題: '', 決定事項: '' })
    expect(call.meetingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(saveMinuteAdjustMock).not.toHaveBeenCalled()
  })

  it('localStorage に draft（expectedPath 一致）があれば createMinute に draft の content/title/meetingDate を渡す', async () => {
    const draft: GuestMinuteDraft = {
      templateId: TID,
      title: 'ゲストが入れたタイトル',
      meetingDate: '2026-08-01',
      content: { 議題: 'AIで話した内容', 決定事項: '来月また集まる' },
      overrides: { 議題: { x: 10, y: 20 } },
    }
    writeFormCache(
      localStorage,
      guestAdjustDraftFormId(TID),
      draft,
      GUEST_ADJUST_DRAFT_RESTORE_PATH,
    )
    createMinuteMock.mockResolvedValue({ id: 'm-restored' })
    saveMinuteAdjustMock.mockResolvedValue({ ok: true })

    render(
      <ManualBootstrap
        templateId={TID}
        templateName="家族会議"
        fields={['議題', '決定事項']}
      />,
    )

    await waitFor(() => {
      expect(createMinuteMock).toHaveBeenCalledTimes(1)
    })
    const call = createMinuteMock.mock.calls[0][0]
    expect(call.title).toBe('ゲストが入れたタイトル')
    expect(call.meetingDate).toBe('2026-08-01')
    expect(call.content).toEqual({ 議題: 'AIで話した内容', 決定事項: '来月また集まる' })

    await waitFor(() => {
      expect(saveMinuteAdjustMock).toHaveBeenCalledTimes(1)
    })
    expect(saveMinuteAdjustMock).toHaveBeenCalledWith({
      id: 'm-restored',
      overrides: { 議題: { x: 10, y: 20 } },
      newFields: undefined,
    })

    // 成功後は form-cache キーが消費されている。
    await waitFor(() => {
      expect(
        localStorage.getItem(makeFormCacheKey(guestAdjustDraftFormId(TID))),
      ).toBeNull()
    })
  })

  it('draft に overrides/newFields が無ければ saveMinuteAdjust は呼ばれない', async () => {
    const draft: GuestMinuteDraft = {
      templateId: TID,
      title: 'タイトルのみ',
      meetingDate: '2026-08-02',
      content: { 議題: '本文' },
      overrides: {},
    }
    writeFormCache(
      localStorage,
      guestAdjustDraftFormId(TID),
      draft,
      GUEST_ADJUST_DRAFT_RESTORE_PATH,
    )
    createMinuteMock.mockResolvedValue({ id: 'm-no-overrides' })

    render(
      <ManualBootstrap
        templateId={TID}
        templateName="家族会議"
        fields={['議題', '決定事項']}
      />,
    )

    await waitFor(() => {
      expect(createMinuteMock).toHaveBeenCalledTimes(1)
    })
    expect(saveMinuteAdjustMock).not.toHaveBeenCalled()
  })

  it('expectedPath が不一致の draft（別ページ由来）は復元されず既存の空 content フローになる', async () => {
    const draft: GuestMinuteDraft = {
      templateId: TID,
      title: '別ページの draft',
      meetingDate: '2026-08-03',
      content: { 議題: 'これは使われないはず' },
      overrides: {},
    }
    // expectedPath をわざと別ページにして書き込む。
    writeFormCache(localStorage, guestAdjustDraftFormId(TID), draft, '/some/other/path')
    createMinuteMock.mockResolvedValue({ id: 'm-mismatch' })

    render(
      <ManualBootstrap
        templateId={TID}
        templateName="家族会議"
        fields={['議題', '決定事項']}
      />,
    )

    await waitFor(() => {
      expect(createMinuteMock).toHaveBeenCalledTimes(1)
    })
    const call = createMinuteMock.mock.calls[0][0]
    expect(call.title).toBe('家族会議')
    expect(call.content).toEqual({ 議題: '', 決定事項: '' })
  })

  it('isGuest=false（既定）は通常通り createMinute を呼ぶ', async () => {
    createMinuteMock.mockResolvedValue({ id: 'minute-xxx' })
    render(
      <ManualBootstrap
        templateId={TID}
        templateName="家族会議"
        fields={['議題', '決定事項']}
      />,
    )
    await waitFor(() => {
      expect(createMinuteMock).toHaveBeenCalledTimes(1)
    })
  })

  it('mount 時に 30 分 TTL も超過した form-cache:v1: キーが物理削除される', async () => {
    createMinuteMock.mockResolvedValue({ id: 'minute-sweep' })
    const staleKey = makeFormCacheKey('minutes:new:manual:some-other-template')
    localStorage.setItem(
      staleKey,
      JSON.stringify({
        savedAt: Date.now() - 31 * 60 * 1000,
        expectedPath: '/somewhere',
        values: { x: 'y' },
      }),
    )
    render(
      <ManualBootstrap
        templateId={TID}
        templateName="家族会議"
        fields={['議題', '決定事項']}
      />,
    )
    await waitFor(() => {
      expect(createMinuteMock).toHaveBeenCalledTimes(1)
    })
    expect(localStorage.getItem(staleKey)).toBeNull()
  })

  it('回帰: 5〜30 分前に保存された save-draft は sweep に消されず読み出し可能なまま残る', async () => {
    // 旧バグ: sweep が内部で 5 分固定 TTL 判定していたため、30 分 TTL の save-draft が
    // 5 分経過時点で readFormCache に読まれる前に消されてしまっていた。
    const draft: GuestMinuteDraft = {
      templateId: TID,
      title: 'ゲストが入れたタイトル',
      meetingDate: '2026-08-01',
      content: { 議題: '10 分前に保存した内容', 決定事項: '来月また集まる' },
      overrides: {},
    }
    const TEN_MIN_AGO = Date.now() - 10 * 60 * 1000
    writeFormCache(
      localStorage,
      guestAdjustDraftFormId(TID),
      draft,
      GUEST_ADJUST_DRAFT_RESTORE_PATH,
      TEN_MIN_AGO,
    )
    createMinuteMock.mockResolvedValue({ id: 'minute-survives-sweep' })

    render(
      <ManualBootstrap
        templateId={TID}
        templateName="家族会議"
        fields={['議題', '決定事項']}
      />,
    )

    await waitFor(() => {
      expect(createMinuteMock).toHaveBeenCalledTimes(1)
    })
    const call = createMinuteMock.mock.calls[0][0]
    expect(call.content).toEqual({ 議題: '10 分前に保存した内容', 決定事項: '来月また集まる' })
  })
})
