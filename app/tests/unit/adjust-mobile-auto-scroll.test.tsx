/**
 * AdjustView スマホ用インスペクタ（下部固定モーダル）の自動スクロール unit test。
 *
 * 選択中 bbox（selectionGeom）の下辺とモーダル ref の上辺の位置関係から、
 * 不足分だけ window.scrollBy が呼ばれることを、実コンポーネント経由で検証する
 * （純関数側の網羅ケースは adjust-auto-scroll-delta.test.ts）。
 *
 * mock 構造は adjust-leave-guard-modal.test.tsx を踏襲。bbox-pane mock の選択操作で
 * onSelectionGeom を合わせて発火させ、AdjustViewLayout 側の useEffect を駆動する。
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

type SelectionGeom = {
  name: string
  viewportLeft: number
  viewportTop: number
  width: number
  height: number
}

const { getMockGeom, setMockGeom } = vi.hoisted(() => {
  let geom: SelectionGeom | null = null
  return {
    getMockGeom: () => geom,
    setMockGeom: (g: SelectionGeom | null) => {
      geom = g
    },
  }
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
  }),
}))

vi.mock('@/server/minutes', () => ({
  saveMinuteAdjust: vi.fn(async () => ({ ok: true as const })),
  updateMinute: vi.fn(async () => ({ id: 'm-1' })),
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
      onSelectionGeom,
    }: {
      fields: Field[]
      selectedName: string | null
      onSelect: (name: string) => void
      onSelectionGeom?: (geom: SelectionGeom | null) => void
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
            onClick={() => {
              onSelect(f.name)
              onSelectionGeom?.(getMockGeom())
            }}
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

const FIELDS: TemplateFieldDef[] = [makeTemplateField('attendees', '参加者')]
const PDF_FIELDS: PdfField[] = [makePdfField('attendees', '参加者')]

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

async function renderAdjust() {
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
      initialTitle="初期タイトル"
      initialMeetingDate="2026-06-11"
    />,
  )
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
  })
  return result
}

const scrollBySpy = vi.fn()
let originalGetBoundingClientRect: typeof HTMLElement.prototype.getBoundingClientRect

beforeEach(() => {
  defaultFetchMock()
  setMockGeom(null)
  scrollBySpy.mockClear()
  window.scrollBy = scrollBySpy as unknown as typeof window.scrollBy
  originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect
  // モーダル上辺を固定値 1010px にスタブ（全要素共通。本テストでは他要素の rect は参照しない）。
  HTMLElement.prototype.getBoundingClientRect = vi.fn(
    () =>
      ({
        top: 1010,
        left: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON() {
          return {}
        },
      }) as DOMRect,
  )
})

afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect
  vi.restoreAllMocks()
})

describe('AdjustView スマホ用モーダルの自動スクロール', () => {
  it('選択枠の下辺がモーダル上辺 (1010) に被る場合、不足分だけ scrollBy が呼ばれる', async () => {
    // selectionBottom = 1000 + 20 = 1020 > modalTop 1010 → gap=-10 → delta = 4 - (-10) = 14
    setMockGeom({
      name: 'attendees',
      viewportLeft: 0,
      viewportTop: 1000,
      width: 100,
      height: 20,
    })
    await renderAdjust()
    await act(async () => {
      fireEvent.click(screen.getByTestId('bbox-field-attendees'))
      await Promise.resolve()
    })
    expect(scrollBySpy).toHaveBeenCalledWith({ top: 14, behavior: 'smooth' })
  })

  it('既に 4px 以上の余白がある場合 scrollBy は呼ばれない', async () => {
    // selectionBottom = 900 + 20 = 920。modalTop 1010 との gap=90 (>=4) → delta=0
    setMockGeom({
      name: 'attendees',
      viewportLeft: 0,
      viewportTop: 900,
      width: 100,
      height: 20,
    })
    await renderAdjust()
    await act(async () => {
      fireEvent.click(screen.getByTestId('bbox-field-attendees'))
      await Promise.resolve()
    })
    expect(scrollBySpy).not.toHaveBeenCalled()
  })

  it('PC 幅相当（モーダルが display:none）の場合、zero-rect でも scrollBy は呼ばれない', async () => {
    // モーダル div は selectedField の真偽だけで DOM にマウントされ、md:hidden は CSS 非表示のみ
    // （display:none）。jsdom は実 CSS を評価しないため、ここでは getComputedStyle をモックして
    // その状態を再現する。beforeEach の getBoundingClientRect スタブは zero-rect ではなく
    // top:1010 を返す設定のままだが、display:none 判定が先に効けば scrollBy 自体呼ばれない。
    const originalGetComputedStyle = window.getComputedStyle
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, ...rest) => {
      if (el instanceof HTMLElement && el.classList.contains('bottom-14')) {
        return { display: 'none' } as CSSStyleDeclaration
      }
      return originalGetComputedStyle(el, ...rest)
    })
    // selectionBottom = 1000 + 20 = 1020 > modalTop 1010 → 非表示判定がなければ delta=14 で
    // scrollBy が呼ばれてしまうケース（1 つ目のテストと同じ geom）。
    setMockGeom({
      name: 'attendees',
      viewportLeft: 0,
      viewportTop: 1000,
      width: 100,
      height: 20,
    })
    await renderAdjust()
    await act(async () => {
      fireEvent.click(screen.getByTestId('bbox-field-attendees'))
      await Promise.resolve()
    })
    expect(scrollBySpy).not.toHaveBeenCalled()
  })

  it('geom の name が選択中フィールドと一致しない場合、scrollBy は呼ばれない', async () => {
    // 選択切替直後は親 effect が「1 つ前の選択の geom」を掴んだまま発火しうる。
    // その古い geom（別 field 由来）で相対スクロールしないことを検証する。
    // ジオメトリ自体は 1 つ目のテストと同じ = name 判定が無ければ delta=14 で呼ばれてしまう。
    setMockGeom({
      name: 'previous-field',
      viewportLeft: 0,
      viewportTop: 1000,
      width: 100,
      height: 20,
    })
    await renderAdjust()
    await act(async () => {
      fireEvent.click(screen.getByTestId('bbox-field-attendees'))
      await Promise.resolve()
    })
    expect(scrollBySpy).not.toHaveBeenCalled()
  })
})
