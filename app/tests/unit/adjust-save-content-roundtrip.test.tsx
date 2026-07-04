/**
 * AdjustView 保存 → content roundtrip 真因切り分けテスト。
 *
 * 症状: 家族会議 builtin から新規議事録作成 → AdjustView 着地 → 各 bbox に値入力
 *       → 「保存」ボタン押下 → reload / 議事録一覧から再オープン → 入力値が消える。
 *
 * 真因切り分け観点:
 *   1. AdjustView の onSave で saveMinuteAdjust が呼ばれるか
 *   2. content payload に inspector 入力値が含まれているか
 *   3. payload は「全 field の name をキーとした Record<string,string>」になっているか
 *
 * 既存 `adjust-new-field-e2e.test.tsx` を雛形に、保存ボタン経路にフォーカスする。
 * BboxPane / NudgeControls は最小 stub、saveMinuteAdjust は spy で受け取り内容を assert。
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

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
  }),
}))

vi.mock('@/server/minutes', () => ({
  saveMinuteAdjust: (input: SaveMinuteAdjustPayload) =>
    saveMinuteAdjustSpy(input),
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
    showToast: vi.fn(),
    dismissToast: vi.fn(),
  }),
}))

vi.mock('@/app/(dashboard)/templates/[id]/nudge-controls', () => {
  return {
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
  }
})

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

function makeTemplateField(
  name: string,
  label: string,
  multiline = false,
): TemplateFieldDef {
  return {
    name,
    label,
    bbox: { x: 50, y: 100, w: 200, h: 24 },
    multiline,
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

// 家族会議 builtin 同等の 5 項目（discussion 含む・seed.sql 準拠）。
const BUILTIN_FAMILY_MEETING_FIELDS: Array<{
  name: string
  label: string
  multiline: boolean
}> = [
  { name: 'attendees', label: '参加者', multiline: true },
  { name: 'agenda', label: '議題', multiline: true },
  { name: 'discussion', label: '議事内容', multiline: true },
  { name: 'decisions', label: '決定事項', multiline: true },
  { name: 'todos', label: 'TODO', multiline: true },
]

describe('AdjustView 保存→content roundtrip', () => {
  beforeEach(() => {
    saveMinuteAdjustSpy.mockClear()
    updateMinuteSpy.mockClear()
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
      return {
        ok: true,
        json: async () => ({}),
      } as Response
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function renderAdjust() {
    const fields: TemplateFieldDef[] = BUILTIN_FAMILY_MEETING_FIELDS.map((f) =>
      makeTemplateField(f.name, f.label, f.multiline),
    )
    const pdfFields: PdfField[] = BUILTIN_FAMILY_MEETING_FIELDS.map((f) =>
      makePdfField(f.name, f.label),
    )
    // 初期値はすべて空文字（ManualBootstrap で createMinute する際の content と同形）。
    const initialValues: Record<string, string> = Object.fromEntries(
      fields.map((f) => [f.name, '']),
    )
    const result = render(
      <AdjustView
        minuteId="m-1"
        templateId="t-1"
        fields={fields}
        pdfFields={pdfFields}
        initialOverrides={{}}
        initialValues={initialValues}
        initialTitle="家族会議"
        initialMeetingDate="2026-06-11"
      />,
    )
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
    })
    return result
  }

  it('各 bbox に値入力 → 保存ボタン → saveMinuteAdjust の content に全入力値が含まれる', async () => {
    const { container } = await renderAdjust()

    // 各 field を順に選択 → aside textarea に値入力。
    const inputs: Record<string, string> = {
      attendees: 'pppppp',
      agenda: 'p',
      discussion: 'p',
      decisions: 'p',
      todos: 'p',
    }
    for (const [name, value] of Object.entries(inputs)) {
      // BboxPane mock の field ボタンを click して selected を切り替える。
      await act(async () => {
        fireEvent.click(screen.getByTestId(`bbox-field-${name}`))
        await Promise.resolve()
      })
      // aside 内の textarea（multiline=true なので textarea）を取得。
      // 各 field 共通 ref のため、selected 切替後に最新の textarea を取り直す。
      const asideTextarea = container.querySelector(
        'aside textarea',
      ) as HTMLTextAreaElement | null
      expect(asideTextarea).toBeTruthy()
      await act(async () => {
        fireEvent.change(asideTextarea!, { target: { value } })
        await Promise.resolve()
      })
    }

    // 「保存」ボタン押下。
    const saveButton = screen.getByText('保存') as HTMLButtonElement
    expect(saveButton.disabled).toBe(false) // dirty 活性
    await act(async () => {
      fireEvent.click(saveButton)
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(saveMinuteAdjustSpy).toHaveBeenCalledTimes(1)
    const payload = saveMinuteAdjustSpy.mock.calls[0][0]
    expect(payload.id).toBe('m-1')
    // 真因切り分けの核心: 各 field の入力値が content に含まれているか。
    expect(payload.content).toMatchObject(inputs)
  })
})
