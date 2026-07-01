/**
 * AdjustView guestMode prop（GA2: guest_adjustview_redesign）の統合動作テスト。
 *
 * 既存 adjust-leave-guard-modal.test.tsx の mock 構造を踏襲する。guestMode を渡さない
 * 既存呼び出しはこのファイルでは検証しない（そちらのスイートが非劣化を別途担保する）。
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

const saveMinuteAdjustSpy = vi.fn(async (_input: unknown) => ({ ok: true as const }))
const updateMinuteSpy = vi.fn(async (_input: unknown) => ({ id: 'm-1' }))
const routerPushSpy = vi.fn()
const showToastSpy = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: routerPushSpy,
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
  }),
}))

vi.mock('@/server/minutes', () => ({
  saveMinuteAdjust: (input: unknown) => saveMinuteAdjustSpy(input),
  updateMinute: (input: unknown) => updateMinuteSpy(input),
}))

vi.mock('@/lib/parsers/pdf/preview-font-loader', () => ({
  loadPreviewFont: vi.fn(async () => null),
}))

vi.mock('@/lib/utils/use-debounced-selected-background', () => ({
  useDebouncedSelectedBackground: () => null,
}))

vi.mock('@/components/toast/toast-context', () => ({
  useToast: () => ({
    toasts: [],
    showToast: showToastSpy,
    dismissToast: vi.fn(),
  }),
}))

vi.mock('@/app/(dashboard)/templates/[id]/nudge-controls', () => ({
  __esModule: true,
  default: () => <div data-testid="nudge-controls-mock" />,
}))

vi.mock('@/app/(dashboard)/templates/[id]/bbox-pane', () => {
  type Field = { name: string; label: string }
  return {
    __esModule: true,
    default: ({
      fields,
      onSelect,
    }: {
      fields: Field[]
      onSelect: (name: string) => void
    }) => (
      <div
        data-testid="bbox-pane-mock"
        data-field-names={fields.map((f) => f.name).join(',')}
      >
        {fields.map((f) => (
          <button
            key={f.name}
            data-testid={`bbox-field-${f.name}`}
            onClick={() => onSelect(f.name)}
          >
            {f.label}
          </button>
        ))}
      </div>
    ),
  }
})

import { AdjustView } from '@/app/(dashboard)/minutes/[id]/adjust/AdjustView'
import type { TemplateFieldDef } from '@/app/(dashboard)/minutes/[id]/adjust/AdjustView'
import { PdfFieldSchemaZ, type PdfField } from '@/lib/ai/schemas/pdf-field-schema'

function makeTemplateField(name: string, label: string): TemplateFieldDef {
  return { name, label, bbox: { x: 50, y: 100, w: 200, h: 24 }, multiline: true }
}
function makePdfField(name: string, label: string): PdfField {
  return PdfFieldSchemaZ.parse({
    name,
    label,
    type: 'text',
    bbox: { page: 1, x: 50, y: 100, w: 200, h: 24 },
    max_chars: 200,
    font: { family: 'NotoSansJP', size: 11 },
  })
}

const FIELDS: TemplateFieldDef[] = [makeTemplateField('attendees', '参加者')]
const PDF_FIELDS: PdfField[] = [makePdfField('attendees', '参加者')]

let fetchCalls: { url: string; body: unknown }[] = []

function guestFetchMock() {
  fetchCalls = []
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const body = init?.body ? JSON.parse(init.body as string) : undefined
    fetchCalls.push({ url, body })
    if (url.includes('/api/guest/render-image')) {
      return {
        ok: true,
        blob: async () => new Blob(['fake-png-bytes']),
      } as unknown as Response
    }
    return { ok: true, json: async () => ({}) } as Response
  }) as unknown as typeof fetch
}

async function renderGuestAdjust(
  onGuestSave: (draft: unknown) => void = vi.fn(),
) {
  const initialValues: Record<string, string> = { attendees: '' }
  const result = render(
    <AdjustView
      minuteId="guest"
      templateId="00000000-0000-0000-0000-000000000001"
      fields={FIELDS}
      pdfFields={PDF_FIELDS}
      initialOverrides={{}}
      initialValues={initialValues}
      initialTitle="家族会議"
      initialMeetingDate="2026-07-01"
      guestMode
      renderImageEndpoint="/api/guest/render-image"
      onGuestSave={onGuestSave}
    />,
  )
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
  })
  return result
}

beforeEach(() => {
  saveMinuteAdjustSpy.mockClear()
  updateMinuteSpy.mockClear()
  routerPushSpy.mockClear()
  showToastSpy.mockClear()
  guestFetchMock()
  // jsdom does not implement URL.createObjectURL/revokeObjectURL.
  global.URL.createObjectURL = vi.fn(() => 'blob:mock-url')
  global.URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AdjustView guestMode — pageSizes / 背景取得', () => {
  it('guestMode では /api/templates/[id]/bbox-editor を一切呼ばず即座に BboxPane が描画される', async () => {
    await renderGuestAdjust()
    expect(screen.getByTestId('bbox-pane-mock')).toBeTruthy()
    expect(fetchCalls.some((c) => c.url.includes('/bbox-editor'))).toBe(false)
  })

  it('guestMode の背景取得は renderImageEndpoint へ {templateId,content,overrides,raw} を POST する', async () => {
    await renderGuestAdjust()
    const guestCall = fetchCalls.find((c) => c.url.includes('/api/guest/render-image'))
    expect(guestCall).toBeDefined()
    expect(guestCall!.body).toEqual({
      templateId: '00000000-0000-0000-0000-000000000001',
      content: {},
      overrides: {},
      raw: true,
    })
  })

  it('guestMode の背景取得は image/png bytes を objectURL 化する（signedUrl JSON は使わない）', async () => {
    await renderGuestAdjust()
    expect(global.URL.createObjectURL).toHaveBeenCalledTimes(1)
  })
})

describe('AdjustView guestMode — 保存ボタン', () => {
  it('ボタンラベルが「ログインして保存」になる', async () => {
    await renderGuestAdjust()
    expect(screen.getByRole('button', { name: 'ログインして保存' })).toBeTruthy()
  })

  it('押下で onGuestSave が draft を引数に呼ばれ、DB 書き込み / 画面遷移は一切起きない', async () => {
    const onGuestSave = vi.fn()
    const { container } = await renderGuestAdjust(onGuestSave)

    // dirty 化（field 選択 → 値を入力）。
    await act(async () => {
      fireEvent.click(screen.getByTestId('bbox-field-attendees'))
      await Promise.resolve()
    })
    const textarea = container.querySelector('aside textarea') as HTMLTextAreaElement | null
    expect(textarea, 'field 選択後は Inspector textarea が描画される').not.toBeNull()
    await act(async () => {
      fireEvent.change(textarea!, { target: { value: '出席予定' } })
      await Promise.resolve()
    })

    const saveBtn = screen.getByRole('button', { name: 'ログインして保存' })
    await act(async () => {
      fireEvent.click(saveBtn)
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(onGuestSave).toHaveBeenCalledTimes(1)
    })
    const draft = onGuestSave.mock.calls[0][0] as {
      templateId: string
      title: string
      meetingDate: string
      content: Record<string, string>
    }
    expect(draft.templateId).toBe('00000000-0000-0000-0000-000000000001')
    expect(draft.title).toBe('家族会議')
    expect(draft.meetingDate).toBe('2026-07-01')
    expect(saveMinuteAdjustSpy).not.toHaveBeenCalled()
    expect(updateMinuteSpy).not.toHaveBeenCalled()
    expect(routerPushSpy).not.toHaveBeenCalled()
  })
})

/** field を選択 → 値入力して dirty 化する（保存/戻る導線テスト共通の下準備）。 */
async function makeDirty(container: HTMLElement) {
  await act(async () => {
    fireEvent.click(screen.getByTestId('bbox-field-attendees'))
    await Promise.resolve()
  })
  const textarea = container.querySelector('aside textarea') as HTMLTextAreaElement
  await act(async () => {
    fireEvent.change(textarea, { target: { value: '出席予定' } })
    await Promise.resolve()
  })
}

describe('AdjustView guestMode — 「閲覧画面に戻る」導線', () => {
  it('リンクの href / ラベルが guestMode 時は /templates ・「← テンプレ選択に戻る」になる', async () => {
    await renderGuestAdjust()
    const link = screen.getByRole('link', { name: '← テンプレ選択に戻る' })
    expect(link.getAttribute('href')).toBe('/templates')
    expect(screen.queryByText('← 閲覧画面に戻る')).toBeNull()
  })

  it('未保存ガードモーダル「保存して移動」で onGuestSave が呼ばれ、DB へは一切書き込まない', async () => {
    const onGuestSave = vi.fn()
    const { container } = await renderGuestAdjust(onGuestSave)
    await makeDirty(container)

    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: '← テンプレ選択に戻る' }))
      await Promise.resolve()
    })
    expect(screen.getByRole('dialog')).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存して移動' }))
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(onGuestSave).toHaveBeenCalledTimes(1)
    })
    expect(saveMinuteAdjustSpy).not.toHaveBeenCalled()
    expect(updateMinuteSpy).not.toHaveBeenCalled()
    // onGuestSave 側（呼出元）が遷移を担うため、AdjustView 自身は router.push しない。
    expect(routerPushSpy).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('未保存ガードモーダル「保存せず移動」で /templates へ遷移する', async () => {
    const { container } = await renderGuestAdjust()
    await makeDirty(container)

    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: '← テンプレ選択に戻る' }))
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存せず移動' }))
      await Promise.resolve()
    })

    expect(routerPushSpy).toHaveBeenCalledWith('/templates')
    expect(saveMinuteAdjustSpy).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
