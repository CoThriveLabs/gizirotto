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
import type { UseGuestTurnstileGate } from '@/hooks/useGuestTurnstileGate'
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

function guestFetchMock(opts: { formatItemOk?: boolean; formatItemDelta?: string } = {}) {
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
    if (url.includes('/bbox-editor')) {
      // ログイン版が pageSizes 取得に使う認証 route の最小モック。
      return {
        ok: true,
        json: async () => ({
          editable: true,
          pageSizes: [
            {
              page: 1,
              widthPt: 595,
              heightPt: 842,
              pixelWidth: 595,
              pixelHeight: 842,
            },
          ],
        }),
      } as unknown as Response
    }
    if (url.includes('/render-image')) {
      // ログイン版の背景 fetch。signedUrl JSON を返す。
      return {
        ok: true,
        json: async () => ({ signedUrl: 'https://example.com/bg.png' }),
      } as unknown as Response
    }
    if (url.includes('/api/minutes/format-item')) {
      const ok = opts.formatItemOk !== false
      if (!ok) {
        return { ok: false, status: 403, body: null, json: async () => ({}) } as unknown as Response
      }
      // 既定は delta 無し（done のみ）→ onFormat の NO_OUTPUT catch へ落ちる。
      // formatItemDelta 指定時は delta を 1 件流して成功パス（receivedAny=true）を通す。
      const encoder = new TextEncoder()
      const delta = opts.formatItemDelta
      const stream = new ReadableStream({
        pull(controller) {
          if (delta !== undefined) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: delta })}\n\n`),
            )
          }
          controller.enqueue(encoder.encode('data: {"type":"done"}\n\n'))
          controller.close()
        },
      })
      return { ok: true, body: stream } as unknown as Response
    }
    return { ok: true, json: async () => ({}) } as Response
  }) as unknown as typeof fetch
}

/**
 * Test double for UseGuestTurnstileGate. consumeToken は即 token を返す fake。
 * bindWidget は no-op。テストで token 値を変えたい場合は factory 引数で差し替える。
 */
function makeFakeTurnstileGate(token: string | undefined = 'test-turnstile-token'): UseGuestTurnstileGate {
  return {
    onToken: vi.fn(),
    consumeToken: vi.fn(async () => token),
    reset: vi.fn(),
    bindWidget: vi.fn(),
  }
}

async function renderGuestAdjust(
  onGuestSave: (draft: unknown) => void = vi.fn(),
  guestTurnstileGate?: UseGuestTurnstileGate,
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
      guestTurnstileGate={guestTurnstileGate}
    />,
  )
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
  })
  return result
}

/**
 * ログインユーザー版（guestMode/guestTurnstileGate 未指定）を render。
 * (j) 回帰テスト: onFormat の body に turnstileToken が乗らないことを検証する。
 */
async function renderAuthedAdjust() {
  const initialValues: Record<string, string> = { attendees: '' }
  const result = render(
    <AdjustView
      minuteId="m-1"
      templateId="00000000-0000-0000-0000-000000000001"
      fields={FIELDS}
      pdfFields={PDF_FIELDS}
      initialOverrides={{}}
      initialValues={initialValues}
      initialTitle="家族会議"
      initialMeetingDate="2026-07-01"
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

  it('guestMode は dirty=false（未編集）でも保存ボタンが常時活性', async () => {
    await renderGuestAdjust()
    // 何も編集せず初期表示のまま。guestMode は dirty 非依存で活性。
    const saveBtn = screen.getByRole('button', { name: 'ログインして保存' })
    expect(saveBtn).not.toBeDisabled()
  })

  it('guestMode は未編集のまま押下しても onGuestSave が呼ばれる', async () => {
    const onGuestSave = vi.fn()
    await renderGuestAdjust(onGuestSave)
    const saveBtn = screen.getByRole('button', { name: 'ログインして保存' })
    await act(async () => {
      fireEvent.click(saveBtn)
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(onGuestSave).toHaveBeenCalledTimes(1)
    })
    // DB 書き込み・画面遷移は起きない。
    expect(saveMinuteAdjustSpy).not.toHaveBeenCalled()
    expect(routerPushSpy).not.toHaveBeenCalled()
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

describe('AdjustView guestMode — GA5 format-item Turnstile ゲート', () => {
  it('(i) guestMode + guestTurnstileGate 指定下の onFormat: body に turnstileToken が含まれる', async () => {
    const gate = makeFakeTurnstileGate('guest-token-xyz')
    const { container } = await renderGuestAdjust(vi.fn(), gate)
    await makeDirty(container)

    // 「整形する」ボタンを押下
    await act(async () => {
      // PC/スマホ両方の Inspector が描画されるため getAllByRole で複数取得し、最初を発火。
      fireEvent.click(screen.getAllByRole('button', { name: '整形する' })[0])
      await new Promise((r) => setTimeout(r, 0))
    })

    await waitFor(() => {
      expect(fetchCalls.some((c) => c.url.includes('/api/minutes/format-item'))).toBe(true)
    })
    const formatCall = fetchCalls.find((c) => c.url.includes('/api/minutes/format-item'))!
    const body = formatCall.body as { turnstileToken?: string; field_name?: string }
    expect(body.turnstileToken).toBe('guest-token-xyz')
    expect(body.field_name).toBe('attendees')
    // gate.consumeToken が呼ばれたこと
    expect(gate.consumeToken).toHaveBeenCalled()
  })

  it('(j) 回帰: ログイン版（guestTurnstileGate 未指定）の onFormat: body に turnstileToken が含まれない', async () => {
    const { container } = await renderAuthedAdjust()
    await makeDirty(container)

    await act(async () => {
      // PC/スマホ両方の Inspector が描画されるため getAllByRole で複数取得し、最初を発火。
      fireEvent.click(screen.getAllByRole('button', { name: '整形する' })[0])
      await new Promise((r) => setTimeout(r, 0))
    })

    await waitFor(() => {
      expect(fetchCalls.some((c) => c.url.includes('/api/minutes/format-item'))).toBe(true)
    })
    const formatCall = fetchCalls.find((c) => c.url.includes('/api/minutes/format-item'))!
    const body = formatCall.body as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(body, 'turnstileToken')).toBe(false)
  })

  it('(l) format-item 成功時、gate.reset が呼ばれる（次回チャレンジ発火・Cloudflare 仕様）', async () => {
    guestFetchMock({ formatItemOk: true, formatItemDelta: '整形後テキスト' })
    const gate = makeFakeTurnstileGate('token-1')
    const { container } = await renderGuestAdjust(vi.fn(), gate)
    await makeDirty(container)

    await act(async () => {
      // PC/スマホ両方の Inspector が描画されるため getAllByRole で複数取得し、最初を発火。
      fireEvent.click(screen.getAllByRole('button', { name: '整形する' })[0])
      await new Promise((r) => setTimeout(r, 0))
    })

    await waitFor(() => {
      expect(gate.reset).toHaveBeenCalled()
    })
  })

  it('format-item が失敗した場合、gate.reset が呼ばれる（次回チャレンジ発火）', async () => {
    guestFetchMock({ formatItemOk: false })
    const gate = makeFakeTurnstileGate('will-be-consumed')
    const { container } = await renderGuestAdjust(vi.fn(), gate)
    await makeDirty(container)

    await act(async () => {
      // PC/スマホ両方の Inspector が描画されるため getAllByRole で複数取得し、最初を発火。
      fireEvent.click(screen.getAllByRole('button', { name: '整形する' })[0])
      await new Promise((r) => setTimeout(r, 0))
    })

    await waitFor(() => {
      expect(gate.reset).toHaveBeenCalled()
    })
  })
})

describe('AdjustView ログインユーザー — 保存ボタン初回活性（firstSaveConsumed）', () => {
  it('初回表示（未編集・firstSaveConsumed=false）は保存ボタンが活性', async () => {
    await renderAuthedAdjust()
    // ログイン版のラベルは「保存」。dirty=false でも初回は活性。
    const saveBtn = screen.getByRole('button', { name: '保存' })
    expect(saveBtn).not.toBeDisabled()
  })

  it('保存ボタン押下後（保存失敗で画面に留まる）、未編集でも再活性化し即座に再試行できる', async () => {
    // saveMinuteAdjust を reject させ、persistMinute を ok:false にして画面に留めさせる。
    saveMinuteAdjustSpy.mockRejectedValueOnce(new Error('SAVE_FAILED'))
    await renderAuthedAdjust()

    const saveBtn = screen.getByRole('button', { name: '保存' })
    expect(saveBtn).not.toBeDisabled()

    await act(async () => {
      fireEvent.click(saveBtn)
      await Promise.resolve()
    })

    // 保存失敗後も firstSaveConsumed が false に戻るため、未編集のまま活性を維持する
    // （編集やリロードをしなくても即座に再試行できる）。
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '保存' })).not.toBeDisabled()
    })
    expect(saveMinuteAdjustSpy).toHaveBeenCalledTimes(1)
    expect(routerPushSpy).not.toHaveBeenCalled()
  })

  it('回帰: 1 文字編集すると dirty=true で活性のまま（保存成功で画面遷移する正常系）', async () => {
    saveMinuteAdjustSpy.mockResolvedValueOnce({ ok: true })
    const { container } = await renderAuthedAdjust()

    // 1 文字編集で dirty=true → 活性のまま。
    await makeDirty(container)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '保存' })).not.toBeDisabled()
    })

    // 保存成功 → router.push で遷移する（既存挙動不変）。
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(routerPushSpy).toHaveBeenCalledWith('/minutes/m-1')
    })
  })

  it('保存失敗を 2 回連続しても、都度 firstSaveConsumed が戻り再試行できる', async () => {
    saveMinuteAdjustSpy.mockRejectedValueOnce(new Error('SAVE_FAILED_1'))
    saveMinuteAdjustSpy.mockRejectedValueOnce(new Error('SAVE_FAILED_2'))
    await renderAuthedAdjust()

    const saveBtn = screen.getByRole('button', { name: '保存' })
    await act(async () => {
      fireEvent.click(saveBtn)
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '保存' })).not.toBeDisabled()
    })

    // 2 回目も未編集のまま即座に再試行できる。
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(saveMinuteAdjustSpy).toHaveBeenCalledTimes(2)
    })
    expect(screen.getByRole('button', { name: '保存' })).not.toBeDisabled()
    expect(routerPushSpy).not.toHaveBeenCalled()
  })
})
