/**
 * AdjustView 未保存ガード共通モーダル統合 + persistMinute 単体テスト。
 *
 * 設計書: docs/designs/unsaved_changes_modal_design_2026-06-14.md §5-3
 *
 * カバー範囲:
 *   - A1-A9 (統合): dirty 判定・モーダル open/close・3 ボタン分岐・error 振り分け・既存 onSave 非劣化
 *   - P1-P3 (persistMinute): バリデーション + API 呼び出し順序
 *
 * 既存 adjust-save-content-roundtrip.test.tsx の mock 構造を踏襲。
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

type SaveMinuteAdjustPayload = {
  id: string
  content?: Record<string, string>
  overrides?: Record<string, unknown>
  newFields?: unknown[]
}

const saveMinuteAdjustSpy = vi.fn(
  async (_input: SaveMinuteAdjustPayload) => ({ ok: true as const }),
)
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
  saveMinuteAdjust: (input: SaveMinuteAdjustPayload) => saveMinuteAdjustSpy(input),
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
  default: ({
    sizeSlot,
    extra,
  }: {
    sizeSlot?: React.ReactNode
    extra?: React.ReactNode
  }) => (
    <div data-testid="nudge-controls-mock">
      {sizeSlot}
      {extra}
    </div>
  ),
}))

vi.mock('@/app/(dashboard)/templates/[id]/bbox-pane', () => {
  type Field = { name: string; label: string }
  return {
    __esModule: true,
    default: ({
      fields,
      selectedName,
      onSelect,
    }: {
      fields: Field[]
      selectedName: string | null
      onSelect: (name: string) => void
    }) => (
      <div
        data-testid="bbox-pane-mock"
        data-field-names={fields.map((f) => f.name).join(',')}
        data-selected={selectedName ?? ''}
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
import type { TemplateFieldDef } from '@/app/(dashboard)/minutes/[id]/adjust/adjust-view-helpers'
import { PdfFieldSchemaZ, type PdfField } from '@/lib/ai/schemas/pdf-field-schema'

function makeTemplateField(name: string, label: string): TemplateFieldDef {
  return {
    name,
    label,
    bbox: { x: 50, y: 100, w: 200, h: 24 },
    multiline: true,
  }
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

const FIELDS: TemplateFieldDef[] = [
  makeTemplateField('attendees', '参加者'),
  makeTemplateField('agenda', '議題'),
]
const PDF_FIELDS: PdfField[] = [
  makePdfField('attendees', '参加者'),
  makePdfField('agenda', '議題'),
]

function defaultFetchMock() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('/bbox-editor')) {
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
      } as Response
    }
    if (url.includes('/render-image')) {
      return {
        ok: true,
        json: async () => ({ signedUrl: 'https://example.com/bg.png' }),
      } as Response
    }
    return { ok: true, json: async () => ({}) } as Response
  }) as unknown as typeof fetch
}

async function renderAdjust(
  overrides: Partial<{
    initialTitle: string
    initialMeetingDate: string
  }> = {},
) {
  const initialValues: Record<string, string> = Object.fromEntries(
    FIELDS.map((f) => [f.name, '']),
  )
  const result = render(
    <AdjustView
      minuteId="m-1"
      templateId="t-1"
      fields={FIELDS}
      pdfFields={PDF_FIELDS}
      initialOverrides={{}}
      initialValues={initialValues}
      initialTitle={overrides.initialTitle ?? '初期タイトル'}
      initialMeetingDate={overrides.initialMeetingDate ?? '2026-06-11'}
    />,
  )
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
  })
  return result
}

/** 適当に値入力して dirty 化（attendees に文字列）。 */
async function makeDirty(container: HTMLElement) {
  await act(async () => {
    fireEvent.click(screen.getByTestId('bbox-field-attendees'))
    await Promise.resolve()
  })
  const textarea = container.querySelector('aside textarea') as HTMLTextAreaElement
  await act(async () => {
    fireEvent.change(textarea, { target: { value: 'hello' } })
    await Promise.resolve()
  })
}

beforeEach(() => {
  saveMinuteAdjustSpy.mockClear()
  updateMinuteSpy.mockClear()
  routerPushSpy.mockClear()
  showToastSpy.mockClear()
  defaultFetchMock()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AdjustView 未保存ガード共通モーダル (§5-3 A1-A9)', () => {
  it('A1: dirty=false で「閲覧画面に戻る」→ モーダル開かない', async () => {
    await renderAdjust()
    const backLink = screen.getByText('← 閲覧画面に戻る')
    fireEvent.click(backLink)
    // モーダルが描画されないこと
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('A2: dirty=true で「閲覧画面に戻る」→ モーダル open', async () => {
    const { container } = await renderAdjust()
    await makeDirty(container)
    const backLink = screen.getByText('← 閲覧画面に戻る')
    await act(async () => {
      fireEvent.click(backLink)
      await Promise.resolve()
    })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(
      screen.getByText('閲覧画面に戻る前に、編集した内容を保存しますか？'),
    ).toBeTruthy()
  })

  it('A3: モーダル「保存して移動」成功 → router.push + モーダル閉', async () => {
    const { container } = await renderAdjust()
    await makeDirty(container)
    await act(async () => {
      fireEvent.click(screen.getByText('← 閲覧画面に戻る'))
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存して移動' }))
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(saveMinuteAdjustSpy).toHaveBeenCalledTimes(1)
    expect(routerPushSpy).toHaveBeenCalledWith('/minutes/m-1')
  })

  it('A4: metaDirty=true → updateMinute も呼ばれる (saveMinuteAdjust 後)', async () => {
    const { container } = await renderAdjust()
    await makeDirty(container)
    // タイトルを変える → metaDirty
    const titleInput = screen.getByLabelText('タイトル') as HTMLInputElement
    await act(async () => {
      fireEvent.change(titleInput, { target: { value: '新タイトル' } })
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.click(screen.getByText('← 閲覧画面に戻る'))
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存して移動' }))
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(saveMinuteAdjustSpy).toHaveBeenCalledTimes(1)
    expect(updateMinuteSpy).toHaveBeenCalledTimes(1)
    // saveMinuteAdjust が updateMinute より先
    const saveOrder = saveMinuteAdjustSpy.mock.invocationCallOrder[0]
    const updateOrder = updateMinuteSpy.mock.invocationCallOrder[0]
    expect(saveOrder).toBeLessThan(updateOrder)
  })

  it('A5: 保存失敗 → モーダル error 表示・router.push 呼ばれない・トースト出ない', async () => {
    saveMinuteAdjustSpy.mockRejectedValueOnce(new Error('NETWORK_ERROR'))
    const { container } = await renderAdjust()
    await makeDirty(container)
    await act(async () => {
      fireEvent.click(screen.getByText('← 閲覧画面に戻る'))
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存して移動' }))
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(routerPushSpy).not.toHaveBeenCalled()
    expect(showToastSpy).not.toHaveBeenCalled()
    expect(
      screen.getByText('保存に失敗しました。少し時間を置いて再度お試しください。'),
    ).toBeTruthy()
  })

  it('A6: 「保存せず移動」→ router.push 呼ばれる・saveMinuteAdjust 呼ばれない', async () => {
    const { container } = await renderAdjust()
    await makeDirty(container)
    await act(async () => {
      fireEvent.click(screen.getByText('← 閲覧画面に戻る'))
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '保存せず移動' }))
      await Promise.resolve()
    })
    expect(saveMinuteAdjustSpy).not.toHaveBeenCalled()
    expect(routerPushSpy).toHaveBeenCalledWith('/minutes/m-1')
  })

  it('A7: 「キャンセル」→ モーダル閉のみ・router.push 呼ばれない', async () => {
    const { container } = await renderAdjust()
    await makeDirty(container)
    await act(async () => {
      fireEvent.click(screen.getByText('← 閲覧画面に戻る'))
      await Promise.resolve()
    })
    const dialog = screen.getByRole('dialog')
    const cancelInDialog = Array.from(
      dialog.querySelectorAll('button'),
    ).find((b) => b.textContent === 'キャンセル') as HTMLButtonElement
    await act(async () => {
      fireEvent.click(cancelInDialog)
      await Promise.resolve()
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(routerPushSpy).not.toHaveBeenCalled()
    expect(saveMinuteAdjustSpy).not.toHaveBeenCalled()
  })

  it('A9: 既存「保存ボタン」経路 onSave() の非劣化 (成功 → router.push)', async () => {
    const { container } = await renderAdjust()
    await makeDirty(container)
    const saveBtn = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement
    await act(async () => {
      fireEvent.click(saveBtn)
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(saveMinuteAdjustSpy).toHaveBeenCalledTimes(1)
    expect(routerPushSpy).toHaveBeenCalledWith('/minutes/m-1')
  })

  it('A9-fail: 保存ボタン経路の失敗 → トースト + 画面 errorMsg', async () => {
    saveMinuteAdjustSpy.mockRejectedValueOnce(new Error('NETWORK_ERROR'))
    const { container } = await renderAdjust()
    await makeDirty(container)
    const saveBtn = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement
    await act(async () => {
      fireEvent.click(saveBtn)
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(showToastSpy).toHaveBeenCalledWith(
      'error',
      '保存に失敗しました。少し時間を置いて再度お試しください。',
    )
  })
})

describe('persistMinute 単体相当 (§5-3 P1-P3, 統合経路から間接検証)', () => {
  it('P1: title 空 → API 呼ばれず errorMsg 表示 (バリデーション)', async () => {
    const { container } = await renderAdjust({ initialTitle: '' })
    await makeDirty(container)
    const saveBtn = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement
    await act(async () => {
      fireEvent.click(saveBtn)
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(saveMinuteAdjustSpy).not.toHaveBeenCalled()
    expect(screen.getByText('タイトルを入力してください')).toBeTruthy()
    // バリデーション失敗ではトーストは出ない（既存挙動維持）
    expect(showToastSpy).not.toHaveBeenCalled()
  })

  it('P2: meetingDate 形式不正 → API 呼ばれず errorMsg 表示', async () => {
    const { container } = await renderAdjust({ initialMeetingDate: 'invalid' })
    await makeDirty(container)
    const saveBtn = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement
    await act(async () => {
      fireEvent.click(saveBtn)
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(saveMinuteAdjustSpy).not.toHaveBeenCalled()
    expect(screen.getByText('開催日を入力してください')).toBeTruthy()
  })

  it('P3: 正常 + metaDirty → saveMinuteAdjust → updateMinute の順序保証', async () => {
    const { container } = await renderAdjust()
    await makeDirty(container)
    const titleInput = screen.getByLabelText('タイトル') as HTMLInputElement
    await act(async () => {
      fireEvent.change(titleInput, { target: { value: '新タイトル' } })
      await Promise.resolve()
    })
    const saveBtn = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement
    await act(async () => {
      fireEvent.click(saveBtn)
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(saveMinuteAdjustSpy).toHaveBeenCalledTimes(1)
    expect(updateMinuteSpy).toHaveBeenCalledTimes(1)
    const saveOrder = saveMinuteAdjustSpy.mock.invocationCallOrder[0]
    const updateOrder = updateMinuteSpy.mock.invocationCallOrder[0]
    expect(saveOrder).toBeLessThan(updateOrder)
    expect(updateMinuteSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'm-1',
        title: '新タイトル',
        meetingDate: '2026-06-11',
      }),
    )
  })
})
