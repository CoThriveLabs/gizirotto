/**
 * GuestAdjustBootstrap — chat-draft 一回限り合流 + onGuestSave → form-cache 退避 + /login 誘導の
 * 単体テスト。AdjustView 本体は重い依存を持つため軽量モックに差し替える（既存 adjust-*.test.tsx の
 * 「heavy child はモック」方針を踏襲）。
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react'
import { makeFormCacheKey } from '@/lib/utils/form-cache'
import { GUEST_ADJUST_DRAFT_RESTORE_PATH } from '@/lib/utils/guest-adjust-draft'

const pushMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}))

type CapturedProps = {
  initialValues: Record<string, string>
  initialTitle: string
  initialMeetingDate: string
  guestMode?: boolean
  renderImageEndpoint?: string
  onGuestSave?: (draft: unknown) => void
}
let lastProps: CapturedProps | null = null

vi.mock('@/app/(dashboard)/minutes/[id]/adjust/AdjustView', () => ({
  AdjustView: (props: CapturedProps) => {
    lastProps = props
    return (
      <div data-testid="adjust-view-mock">
        <span data-testid="initial-values">{JSON.stringify(props.initialValues)}</span>
        <button
          onClick={() =>
            props.onGuestSave?.({
              templateId: '00000000-0000-0000-0000-000000000001',
              title: props.initialTitle,
              meetingDate: props.initialMeetingDate,
              content: props.initialValues,
              overrides: {},
            })
          }
        >
          mock-save
        </button>
      </div>
    )
  },
}))

import { GuestAdjustBootstrap } from '@/app/(public-flow)/minutes/new/adjust/GuestAdjustBootstrap'
import type { TemplateFieldDef } from '@/app/(dashboard)/minutes/[id]/adjust/AdjustView'

const TID = '00000000-0000-0000-0000-000000000001'
const FIELDS: TemplateFieldDef[] = [
  { name: 'attendees', label: '参加者', bbox: { x: 0, y: 0, w: 100, h: 20 } },
  { name: 'agenda', label: '議題', bbox: { x: 0, y: 30, w: 100, h: 20 } },
]

beforeEach(() => {
  pushMock.mockReset()
  lastProps = null
  sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  sessionStorage.clear()
})

describe('GuestAdjustBootstrap', () => {
  it('chat-draft が無ければサーバ計算済の空 initialValues がそのまま使われる', async () => {
    render(
      <GuestAdjustBootstrap
        templateId={TID}
        templateName="家族会議"
        fields={FIELDS}
        pdfFields={[]}
        initialOverrides={{}}
        initialValues={{ attendees: '', agenda: '' }}
      />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('adjust-view-mock')).toBeTruthy()
    })
    expect(lastProps?.initialValues).toEqual({ attendees: '', agenda: '' })
    expect(lastProps?.guestMode).toBe(true)
    expect(lastProps?.renderImageEndpoint).toBe('/api/guest/render-image')
  })

  it('chat-draft が sessionStorage にあれば初期値へマージされ、キーは消費される', async () => {
    sessionStorage.setItem(
      `minutes:guest-chat-draft:${TID}`,
      JSON.stringify({ attendees: 'AIで抽出した参加者' }),
    )
    render(
      <GuestAdjustBootstrap
        templateId={TID}
        templateName="家族会議"
        fields={FIELDS}
        pdfFields={[]}
        initialOverrides={{}}
        initialValues={{ attendees: '', agenda: '' }}
      />,
    )
    await waitFor(() => {
      expect(lastProps?.initialValues.attendees).toBe('AIで抽出した参加者')
    })
    expect(lastProps?.initialValues.agenda).toBe('')
    expect(sessionStorage.getItem(`minutes:guest-chat-draft:${TID}`)).toBeNull()
  })

  it('壊れた chat-draft（不正 JSON）は無視して空初期値のまま続行する', async () => {
    sessionStorage.setItem(`minutes:guest-chat-draft:${TID}`, '{not valid json')
    render(
      <GuestAdjustBootstrap
        templateId={TID}
        templateName="家族会議"
        fields={FIELDS}
        pdfFields={[]}
        initialOverrides={{}}
        initialValues={{ attendees: '', agenda: '' }}
      />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('adjust-view-mock')).toBeTruthy()
    })
    expect(lastProps?.initialValues).toEqual({ attendees: '', agenda: '' })
  })

  it('保存ボタン経路（onGuestSave）で form-cache へ snapshot 保存 + /login?next=... へ遷移する', async () => {
    render(
      <GuestAdjustBootstrap
        templateId={TID}
        templateName="家族会議"
        fields={FIELDS}
        pdfFields={[]}
        initialOverrides={{}}
        initialValues={{ attendees: '', agenda: '' }}
      />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('adjust-view-mock')).toBeTruthy()
    })
    await act(async () => {
      fireEvent.click(screen.getByText('mock-save'))
    })

    const formId = `minutes:new:adjust:${TID}`
    const raw = sessionStorage.getItem(makeFormCacheKey(formId))
    expect(raw).not.toBeNull()
    const stored = JSON.parse(raw!) as {
      expectedPath: string
      values: { templateId: string }
    }
    expect(stored.values.templateId).toBe(TID)
    // 復元側（ManualBootstrap）が expectedPath 一致判定で拾えるよう、書き込み時の
    // expectedPath は復元先ページ（/minutes/new/manual）と一致していなければならない。
    expect(stored.expectedPath).toBe(GUEST_ADJUST_DRAFT_RESTORE_PATH)

    expect(pushMock).toHaveBeenCalledWith(
      `/login?next=${encodeURIComponent(`/minutes/new/adjust?template_id=${TID}`)}`,
    )
  })

  it('React.StrictMode 二重マウントでも chat-draft を正しく反映する（sessionStorage 消費は 1 回のみ）', async () => {
    sessionStorage.setItem(
      `minutes:guest-chat-draft:${TID}`,
      JSON.stringify({ attendees: 'StrictMode下でも残るはず' }),
    )
    render(
      <React.StrictMode>
        <GuestAdjustBootstrap
          templateId={TID}
          templateName="家族会議"
          fields={FIELDS}
          pdfFields={[]}
          initialOverrides={{}}
          initialValues={{ attendees: '', agenda: '' }}
        />
      </React.StrictMode>,
    )
    // StrictMode は開発ビルドで effect を mount→cleanup→再mount と 2 回走らせる。
    // draftConsumedRef ガード無しだと 1 回目で sessionStorage キーを消費してしまい、
    // 実際にコミットされる 2 回目では既に空になって content が失われる。
    await waitFor(() => {
      expect(lastProps?.initialValues.attendees).toBe('StrictMode下でも残るはず')
    })
    expect(lastProps?.initialValues.agenda).toBe('')
    // 消費後は sessionStorage から消えている（残骸なし・二重消費で例外も起きない）。
    expect(sessionStorage.getItem(`minutes:guest-chat-draft:${TID}`)).toBeNull()
  })

  it('AI 抽出失敗時の実データ形（meeting_date に会話全文・fields 側は全空）: fields[0] へ救済される', async () => {
    // ChatView.onFinalize の fallback（extractFieldsFromChat 失敗）が実際に書き込む形。
    // meeting_date は AdjustView 側 fields（bbox 必須）に存在しない論理フィールド。
    sessionStorage.setItem(
      `minutes:guest-chat-draft:${TID}`,
      JSON.stringify({
        meeting_date: '[ユーザー] 家族会議をします\n[AI] 了解しました。まず議題からどうぞ。',
        attendees: '',
        agenda: '',
        decisions: '',
        todos: '',
        discussion: '',
      }),
    )
    render(
      <GuestAdjustBootstrap
        templateId={TID}
        templateName="家族会議"
        fields={FIELDS}
        pdfFields={[]}
        initialOverrides={{}}
        initialValues={{ attendees: '', agenda: '' }}
      />,
    )
    await waitFor(() => {
      expect(lastProps?.initialValues.attendees).toBe(
        '[ユーザー] 家族会議をします\n[AI] 了解しました。まず議題からどうぞ。',
      )
    })
    expect(lastProps?.initialValues.agenda).toBe('')
  })

  it('AI 抽出成功相当のデータ形（fields 側に既に値あり）: 救済ロジックは発動せず meeting_date は誤転記されない', async () => {
    sessionStorage.setItem(
      `minutes:guest-chat-draft:${TID}`,
      JSON.stringify({
        meeting_date: '2026-07-15',
        attendees: '田中さん、佐藤さん',
        agenda: '来月の旅行について',
      }),
    )
    render(
      <GuestAdjustBootstrap
        templateId={TID}
        templateName="家族会議"
        fields={FIELDS}
        pdfFields={[]}
        initialOverrides={{}}
        initialValues={{ attendees: '', agenda: '' }}
      />,
    )
    await waitFor(() => {
      expect(lastProps?.initialValues.attendees).toBe('田中さん、佐藤さん')
    })
    expect(lastProps?.initialValues.agenda).toBe('来月の旅行について')
    // meeting_date の値が fields[0]（attendees）へ誤って上書きされていないこと。
    expect(lastProps?.initialValues.attendees).not.toBe('2026-07-15')
    // meeting_date というキー自体が initialValues に紛れ込んでもいない（fields に無いので無視される）。
    expect(Object.keys(lastProps?.initialValues ?? {})).not.toContain('meeting_date')
  })
})
