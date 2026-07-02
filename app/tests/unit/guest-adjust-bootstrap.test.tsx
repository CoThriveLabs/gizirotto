/**
 * GuestAdjustBootstrap — chat-draft 一回限り合流 + onGuestSave → form-cache 退避 + /login 誘導の
 * 単体テスト。AdjustView 本体は重い依存を持つため軽量モックに差し替える（既存 adjust-*.test.tsx の
 * 「heavy child はモック」方針を踏襲）。
 *
 * chat-draft / save-draft はいずれも form-cache（localStorage・TTL 付き）経由で書かれるため、
 * 生の localStorage キーではなく writeFormCache / makeFormCacheKey(guestChatDraftFormId(...)) 越しに
 * 検証する。
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react'
import { makeFormCacheKey, writeFormCache } from '@/lib/utils/form-cache'
import {
  guestAdjustDraftFormId,
  GUEST_ADJUST_DRAFT_RESTORE_PATH,
  guestChatDraftFormId,
  GUEST_CHAT_DRAFT_RESTORE_PATH,
} from '@/lib/utils/guest-adjust-draft'
import type { GuestMinuteDraft } from '@/app/(dashboard)/minutes/[id]/adjust/AdjustView'
import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'

const pushMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}))

type CapturedProps = {
  initialValues: Record<string, string>
  initialTitle: string
  initialMeetingDate: string
  fields: Array<{ name: string; label: string }>
  pdfFields: Array<{ name: string; label: string }>
  initialOverrides: Record<string, unknown>
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
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  localStorage.clear()
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

  it('chat-draft が form-cache（localStorage）にあれば初期値へマージされ、キーは消費される', async () => {
    writeChatDraft({ content: { attendees: 'AIで抽出した参加者' } })
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
    expect(localStorage.getItem(chatDraftKey())).toBeNull()
  })

  it('壊れた chat-draft（不正 JSON）は無視して空初期値のまま続行する', async () => {
    localStorage.setItem(chatDraftKey(), '{not valid json')
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
    const raw = localStorage.getItem(makeFormCacheKey(formId))
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

  it('React.StrictMode 二重マウントでも chat-draft を正しく反映する（localStorage 消費は 1 回のみ）', async () => {
    writeChatDraft({ content: { attendees: 'StrictMode下でも残るはず' } })
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
    // draftConsumedRef ガード無しだと 1 回目で localStorage キーを消費してしまい、
    // 実際にコミットされる 2 回目では既に空になって content が失われる。
    await waitFor(() => {
      expect(lastProps?.initialValues.attendees).toBe('StrictMode下でも残るはず')
    })
    expect(lastProps?.initialValues.agenda).toBe('')
    // 消費後は localStorage から消えている（残骸なし・二重消費で例外も起きない）。
    expect(localStorage.getItem(chatDraftKey())).toBeNull()
  })

  it('AI 抽出失敗時の実データ形（meeting_date に会話全文・fields 側は全空）: fields[0] へ救済される', async () => {
    // ChatView.onFinalize の fallback（extractFieldsFromChat 失敗）が実際に書き込む形。
    // meeting_date は AdjustView 側 fields（bbox 必須）に存在しない論理フィールド。
    writeChatDraft({
      content: {
        meeting_date: '[ユーザー] 家族会議をします\n[AI] 了解しました。まず議題からどうぞ。',
        attendees: '',
        agenda: '',
        decisions: '',
        todos: '',
        discussion: '',
      },
    })
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
    writeChatDraft({
      content: {
        meeting_date: '2026-07-15',
        attendees: '田中さん、佐藤さん',
        agenda: '来月の旅行について',
      },
    })
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

function makeNewField(name: string, label: string): PdfField {
  return {
    name,
    label,
    type: 'text',
    bbox: { page: 1, x: 10, y: 10, w: 100, h: 20 },
    max_chars: 200,
    font: { family: 'NotoSansJP', size: 11 },
    padding: { left: 4, top: 4, right: 4, bottom: 4 },
    multiline: false,
    align: 'left',
    vertical: 'top',
    writing_mode: 'horizontal',
    overflow_strategy: 'shrink_then_wrap',
    font_size_min: 8,
  }
}

function makeSaveDraft(overrides: Partial<GuestMinuteDraft> = {}): GuestMinuteDraft {
  return {
    templateId: TID,
    title: 'ゲストが入れたタイトル',
    meetingDate: '2026-08-01',
    content: { attendees: '田中さん', agenda: '来月の予定' },
    overrides: { attendees: { x: 5, y: 5 } },
    ...overrides,
  }
}

/** save-draft を form-cache（localStorage）へ直接書き込むテスト用ヘルパ。 */
function writeSaveDraft(draft: GuestMinuteDraft, now?: number) {
  writeFormCache(
    localStorage,
    guestAdjustDraftFormId(TID),
    draft,
    GUEST_ADJUST_DRAFT_RESTORE_PATH,
    now,
  )
}

/** chat-draft を form-cache（localStorage）へ直接書き込むテスト用ヘルパ。ChatView の書き込み形を模す。 */
function writeChatDraft(
  values: { content: Record<string, unknown>; meetingDate?: unknown },
  now?: number,
) {
  writeFormCache(
    localStorage,
    guestChatDraftFormId(TID),
    values,
    GUEST_CHAT_DRAFT_RESTORE_PATH,
    now,
  )
}

function chatDraftKey(): string {
  return makeFormCacheKey(guestChatDraftFormId(TID))
}

describe('GuestAdjustBootstrap — save-draft 復元（優先: save-draft > chat-draft > 空）', () => {
  it('(m) save-draft 存在時、AdjustView へ initialTitle/initialMeetingDate/initialValues/initialOverrides が save-draft 内容で渡る', async () => {
    writeSaveDraft(makeSaveDraft())
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
    expect(lastProps?.initialTitle).toBe('ゲストが入れたタイトル')
    expect(lastProps?.initialMeetingDate).toBe('2026-08-01')
    expect(lastProps?.initialValues).toEqual({ attendees: '田中さん', agenda: '来月の予定' })
    expect(lastProps?.initialOverrides).toEqual({ attendees: { x: 5, y: 5 } })
  })

  it('(n) save-draft 読み取り後も localStorage から削除されていない（消費しない・読み取り専用）', async () => {
    writeSaveDraft(makeSaveDraft())
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
      expect(lastProps?.initialTitle).toBe('ゲストが入れたタイトル')
    })
    // GuestAdjustBootstrap は読み取り専用。消費（clearFormCache）は行わない。
    const raw = localStorage.getItem(makeFormCacheKey(guestAdjustDraftFormId(TID)))
    expect(raw).not.toBeNull()
    const stored = JSON.parse(raw!) as { values: GuestMinuteDraft }
    expect(stored.values.title).toBe('ゲストが入れたタイトル')
  })

  it('(o) save-draft に newFields がある場合、fields/pdfFields にマージされて渡る', async () => {
    const newField = makeNewField('custom_field_1', 'カスタム項目')
    writeSaveDraft(makeSaveDraft({ newFields: [newField] }))
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
      expect(lastProps?.initialTitle).toBe('ゲストが入れたタイトル')
    })
    // pdfFields には元の（空）+ newFields がマージされている。
    expect(lastProps?.pdfFields.some((f) => f.name === 'custom_field_1')).toBe(true)
    // fields（TemplateFieldDef[]）側にも同名で反映されている。
    expect(lastProps?.fields.some((f) => f.name === 'custom_field_1' && f.label === 'カスタム項目')).toBe(
      true,
    )
  })

  it('(p) save-draft と chat-draft 両方存在時、save-draft が優先される', async () => {
    writeSaveDraft(makeSaveDraft())
    writeChatDraft({ content: { attendees: 'chat由来（無視されるはず）' } })
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
      expect(lastProps?.initialTitle).toBe('ゲストが入れたタイトル')
    })
    expect(lastProps?.initialValues.attendees).toBe('田中さん')
    // save-draft 優先時は chat-draft キーは触らない（読んでいないので削除もされない）。
    expect(localStorage.getItem(chatDraftKey())).not.toBeNull()
  })

  it('(q) save-draft 無・chat-draft のみ、既存動作が変わらない（回帰）', async () => {
    writeChatDraft({ content: { attendees: 'AIで抽出した参加者' } })
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
    // chat-draft 経路は従来通り templateName / today がそのまま使われる。
    expect(lastProps?.initialTitle).toBe('家族会議')
    expect(localStorage.getItem(chatDraftKey())).toBeNull()
  })

  it('(r) TTL 超過の save-draft は無視され、chat-draft へフォールバックする', async () => {
    const THIRTY_ONE_MIN_AGO = Date.now() - 31 * 60 * 1000
    writeSaveDraft(makeSaveDraft(), THIRTY_ONE_MIN_AGO)
    writeChatDraft({ content: { attendees: 'chat-draftにフォールバック' } })
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
      expect(lastProps?.initialValues.attendees).toBe('chat-draftにフォールバック')
    })
    expect(lastProps?.initialTitle).toBe('家族会議')
  })

  it('(r-2) TTL 超過の save-draft のみ（chat-draft も無い）は空初期値にフォールバックする', async () => {
    const THIRTY_ONE_MIN_AGO = Date.now() - 31 * 60 * 1000
    writeSaveDraft(makeSaveDraft(), THIRTY_ONE_MIN_AGO)
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
    expect(lastProps?.initialTitle).toBe('家族会議')
  })
})

describe('GuestAdjustBootstrap — chat-draft ネスト構造 + meetingDate', () => {
  it('chat-draft（ネスト形式）に meetingDate があれば AdjustView の initialMeetingDate に渡る', async () => {
    writeChatDraft({
      content: { attendees: 'AIで抽出した参加者' },
      meetingDate: '2026-08-15',
    })
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
    expect(lastProps?.initialMeetingDate).toBe('2026-08-15')
  })

  it('chat-draft の meetingDate が無ければ initialMeetingDate は today（YYYY-MM-DD 形式）にフォールバック', async () => {
    writeChatDraft({ content: { attendees: 'メモ' } })
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
      expect(lastProps?.initialValues.attendees).toBe('メモ')
    })
    expect(lastProps?.initialMeetingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('chat-draft の meetingDate が不正形式なら today にフォールバック', async () => {
    writeChatDraft({ content: { attendees: 'メモ' }, meetingDate: '来週' })
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
      expect(lastProps?.initialValues.attendees).toBe('メモ')
    })
    // '来週' は YYYY-MM-DD にマッチしないので today にフォールバック。
    expect(lastProps?.initialMeetingDate).not.toBe('来週')
    expect(lastProps?.initialMeetingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('chat-draft の meetingDate が形式は正しいが実在しない日付（2026-13-45）なら today にフォールバック（normalizeMeetingDate 統一）', async () => {
    writeChatDraft({ content: { attendees: 'メモ' }, meetingDate: '2026-13-45' })
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
      expect(lastProps?.initialValues.attendees).toBe('メモ')
    })
    // 正規表現は通過するが実在しない日付なので normalizeMeetingDate が弾き today にフォールバック。
    expect(lastProps?.initialMeetingDate).not.toBe('2026-13-45')
    expect(lastProps?.initialMeetingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

const GUEST_LS_NOTICE_SHOWN_KEY = 'minutes:guest-ls-notice-shown'

describe('GuestAdjustBootstrap — localStorage 残留注意モーダル', () => {
  it('初回 mount ではフラグ未セットのためモーダルが開く', async () => {
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
      expect(screen.getByRole('dialog')).toBeTruthy()
    })
    expect(screen.getByText('下書きの保存についてのご案内')).toBeTruthy()
  })

  it('「はじめる」押下でフラグがセットされモーダルが閉じる', async () => {
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
      expect(screen.getByRole('dialog')).toBeTruthy()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'はじめる' }))
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(localStorage.getItem(GUEST_LS_NOTICE_SHOWN_KEY)).toBe('1')
  })

  it('フラグがセット済みなら mount してもモーダルは開かない', async () => {
    localStorage.setItem(GUEST_LS_NOTICE_SHOWN_KEY, '1')
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
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
