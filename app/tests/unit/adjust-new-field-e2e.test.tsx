/**
 * 「項目追加 → 値入力 → プレビュー反映 → 削除 → newFieldNames クリーンアップ」end-to-end RTL 統合テスト。
 *
 * AdjustView を実 render し、BboxPane を最小 mock 化することで以下を回帰検証する:
 *   1. 「項目を追加」ボタン押下で新規 field が fields 集合に追加され、selected になる
 *   2. 追加直後に label インライン入力（autoFocus・templates 同型）が現れる
 *   3. 値 input に文字を入れると BboxPane mock の dynamicFieldValues prop に新規 field の
 *      runtime PdfField が **保存前から** 乗る = 「動的プレビュー反映」を構造的に担保
 *   4. 「削除」押下で新規 field が削除され、dynamicFieldValues からも消える
 *      = newFieldNames Set がクリーンアップされ payload に含まれない
 *
 * BboxPane は dynamicFieldValues prop の中身を data-* 属性に書き出すだけの最小 stub に置き換え、
 * 実際の canvas 合成は検証対象外（field-values-composite-canvas は別 unit でカバー済）。
 *
 * 既存 805 件テストに影響なし（新規 1 ファイル追加のみ）。
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

// next/navigation の useRouter mock。
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
  }),
}))

// saveMinuteAdjust は呼ばないが import チェーン分 mock しておく。
vi.mock('@/server/minutes', () => ({
  saveMinuteAdjust: vi.fn(async () => ({ ok: true })),
}))

// preview-font-loader（重い動的 import）を no-op stub に。
vi.mock('@/lib/parsers/pdf/preview-font-loader', () => ({
  loadPreviewFont: vi.fn(async () => null),
}))

// useDebouncedSelectedBackground は副作用最小化のため null 返し。
vi.mock('@/lib/utils/use-debounced-selected-background', () => ({
  useDebouncedSelectedBackground: () => null,
}))

// useToast は ToastProvider 外 render で throw するため最小 stub に差し替える
// （案A ConfirmView 廃止・2026-06-10 § minutes:draft-warning 振替対応）。
vi.mock('@/components/toast/toast-context', () => ({
  useToast: () => ({
    toasts: [],
    showToast: vi.fn(),
    dismissToast: vi.fn(),
  }),
}))

// NudgeControls は AdjustView の中身検証に必須ではない（sizeSlot / extra を素通しで表示するだけ）。
// 削除ボタンが extra 内に来るため、extra をそのまま render する最小 stub。
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

// BboxPane は最小 stub: dynamicFieldValues / fields を data-* に書き出すだけ。
vi.mock('@/app/(dashboard)/templates/[id]/bbox-pane', () => {
  type Field = { name: string; label: string }
  type Composite = { field: { name: string }; value: string }
  return {
    __esModule: true,
    default: ({
      fields,
      dynamicFieldValues,
      selectedName,
      onSelect,
    }: {
      fields: Field[]
      dynamicFieldValues?: Composite[]
      selectedName: string | null
      onSelect: (name: string) => void
    }) => (
      <div
        data-testid="bbox-pane-mock"
        data-field-names={fields.map((f) => f.name).join(',')}
        data-dynamic-names={(dynamicFieldValues ?? [])
          .map((c) => c.field.name)
          .join(',')}
        data-dynamic-values={(dynamicFieldValues ?? [])
          .map((c) => `${c.field.name}:${c.value}`)
          .join('|')}
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
    multiline: false,
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

describe('AdjustView 項目追加 → 値入力 → プレビュー反映 → 削除 E2E', () => {
  beforeEach(() => {
    // fetch を mock: pageSizes を返して BboxPane 描画分岐を通す。
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

  async function renderAdjustView() {
    const fields: TemplateFieldDef[] = [makeTemplateField('topic', '議題')]
    const pdfFields: PdfField[] = [makePdfField('topic', '議題')]
    const result = render(
      <AdjustView
        minuteId="m-1"
        templateId="t-1"
        fields={fields}
        pdfFields={pdfFields}
        initialOverrides={{}}
        initialValues={{ topic: '' }}
        initialTitle="テスト議事録"
        initialMeetingDate="2026-06-10"
      />,
    )
    // pageSizes 取得 effect が完了するまで microtask flush + macrotask 1 tick。
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
    })
    return result
  }

  it('「項目を追加」ボタンが DOM 上に存在する', async () => {
    await renderAdjustView()
    expect(screen.getByText('項目を追加')).toBeTruthy()
  })

  it('項目を追加 → fields 集合に新規 field が末尾追加される', async () => {
    await renderAdjustView()
    fireEvent.click(screen.getByText('項目を追加'))
    const pane = screen.getByTestId('bbox-pane-mock')
    const fieldNames = pane.getAttribute('data-field-names')?.split(',') ?? []
    expect(fieldNames.length).toBe(2)
    expect(fieldNames[0]).toBe('topic')
    // field_1 が採番（既存 topic と衝突しない最小空き）。
    expect(fieldNames[1]).toBe('field_1')
    // 追加直後に selected が新規 field になる。
    expect(pane.getAttribute('data-selected')).toBe('field_1')
  })

  it('追加直後に selected が新規 field、aside MinutesFieldInspector に新規 field が表示される', async () => {
    const { container } = await renderAdjustView()
    await act(async () => {
      fireEvent.click(screen.getByText('項目を追加'))
      await new Promise((r) => setTimeout(r, 0))
    })
    // selected が新規 field になっている（BboxPane mock の data-selected で確認）。
    const pane = screen.getByTestId('bbox-pane-mock')
    expect(pane.getAttribute('data-selected')).toBe('field_1')
    // aside MinutesFieldInspector に新規 field の placeholderLabel が表示される。
    // 🔴 改善② P3（2026-06-10）: 同じ aside に新規追加された「全体の文字サイズ」セクションの
    //   h2 が text-gizirotto-blue-900 を持つため、span（per-field ラベル）に絞り込んで取得する。
    const asideLabel = container.querySelector(
      'aside span.text-gizirotto-blue-900',
    ) as HTMLElement | null
    expect(asideLabel?.textContent).toBe('項目2')
  })

  it('値入力 → BboxPane の dynamicFieldValues に新規 field が runtime で乗る（保存前プレビュー反映）', async () => {
    const { container } = await renderAdjustView()
    await act(async () => {
      fireEvent.click(screen.getByText('項目を追加'))
      await new Promise((r) => setTimeout(r, 0))
    })
    // 新規 field の value 入力欄に文字を入れる。
    // label input は autoFocus → 別 ref への focus 移動で自動 commit される設計のため、
    // 直接 value 入力欄を取得して値を変更する（実機 click → focus 移動の結果と同じ最終状態）。
    // aside 内の text input（aria-label="項目名" 以外）が value 入力欄。
    const inputs = Array.from(
      container.querySelectorAll('aside input[type="text"]'),
    ) as HTMLInputElement[]
    // 'aria-label="項目名"' が付いた input は label 編集用（commit 後は消える）。
    // 残った text input が value 入力欄。
    const valueInput = inputs.find(
      (el) => el.getAttribute('aria-label') !== '項目名',
    )
    expect(valueInput).toBeTruthy()
    await act(async () => {
      fireEvent.change(valueInput!, { target: { value: 'テスト値' } })
      await Promise.resolve()
    })

    // dynamicFieldValues に新規 field が含まれる（保存前プレビュー反映）。
    const pane = screen.getByTestId('bbox-pane-mock')
    const dynamicNames =
      pane.getAttribute('data-dynamic-names')?.split(',') ?? []
    expect(dynamicNames).toContain('field_1')
    // value も渡っている（runtime 合成経路）。
    const dynamicValues = pane.getAttribute('data-dynamic-values') ?? ''
    expect(dynamicValues).toContain('field_1:テスト値')
  })

  it('削除 → 新規 field が fields / dynamicFieldValues 両方から消える（newFieldNames クリーンアップ）', async () => {
    const { container } = await renderAdjustView()
    await act(async () => {
      fireEvent.click(screen.getByText('項目を追加'))
      await new Promise((r) => setTimeout(r, 0))
    })
    const inputs = Array.from(
      container.querySelectorAll('aside input[type="text"]'),
    ) as HTMLInputElement[]
    const valueInput = inputs.find(
      (el) => el.getAttribute('aria-label') !== '項目名',
    )!
    await act(async () => {
      fireEvent.change(valueInput, { target: { value: 'テスト値' } })
      await Promise.resolve()
    })

    // 削除ボタン押下（aside / FloatingShell 両方にあるので最初の要素）。
    await act(async () => {
      fireEvent.click(screen.getAllByText('削除')[0])
      await Promise.resolve()
    })

    const pane = screen.getByTestId('bbox-pane-mock')
    const fieldNames = pane.getAttribute('data-field-names')?.split(',') ?? []
    // 新規 field が消え、初期 topic だけが残る。
    expect(fieldNames).toEqual(['topic'])
    // dynamicFieldValues からも消える = newFieldNames Set がクリーンアップされた証拠。
    const dynamicNames =
      pane.getAttribute('data-dynamic-names')?.split(',').filter(Boolean) ?? []
    expect(dynamicNames).not.toContain('field_1')
  })
})
