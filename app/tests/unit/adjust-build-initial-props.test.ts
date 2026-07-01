import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * buildAdjustInitialProps (src/app/(dashboard)/minutes/[id]/adjust/build-initial-props.ts)
 * regression coverage.
 *
 * This module was extracted from adjust/page.tsx unchanged (same formulas, relocated),
 * so existing page.tsx/AdjustView behaviour for logged-in users must not shift. These
 * tests exercise the composed function directly so the guest adjust entry (a future
 * session) can reuse it with confidence.
 */

const loadBuiltinBboxOverridesMock = vi.fn()
vi.mock('@/lib/builtin-bbox-loader', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/builtin-bbox-loader')
  >('@/lib/builtin-bbox-loader')
  return {
    ...actual,
    loadBuiltinBboxOverrides: (...args: unknown[]) =>
      loadBuiltinBboxOverridesMock(...args),
  }
})

import { buildAdjustInitialProps } from '@/app/(dashboard)/minutes/[id]/adjust/build-initial-props'

const USER_TEMPLATE_FIELDS = [
  { name: 'attendees', label: '参加者', bbox: { x: 10, y: 10, w: 200, h: 30 } },
  { name: 'agenda', label: '議題', bbox: { x: 10, y: 60, w: 200, h: 30 } },
]

const BUILTIN_FAMILY_MEETING_FIELDS = [
  { name: 'attendees', label_ja: '参加者' },
  { name: 'agenda', label_ja: '議題' },
]

describe('buildAdjustInitialProps', () => {
  beforeEach(() => {
    loadBuiltinBboxOverridesMock.mockReset()
  })

  it('user テンプレ（family_id あり）: bbox JSON fallback を呼ばずテンプレ自身の bbox を使う', async () => {
    const out = await buildAdjustInitialProps({
      template: {
        fields: USER_TEMPLATE_FIELDS,
        fixed_texts: [],
        family_id: 'fam-1',
        processed_path: null,
      },
      contentJson: { attendees: 'A', agenda: '' },
      bboxOverridesRaw: {},
      newFieldsRaw: [],
    })
    expect(loadBuiltinBboxOverridesMock).not.toHaveBeenCalled()
    expect(out.fields.map((f) => f.name)).toEqual(['attendees', 'agenda'])
    expect(out.fields[0].bbox).toEqual({ x: 10, y: 10, w: 200, h: 30 })
    expect(out.initialValues).toEqual({ attendees: 'A', agenda: '' })
  })

  it('builtin テンプレ（family_id null）+ 既知 processed_path: bbox JSON fallback で座標を補完する', async () => {
    loadBuiltinBboxOverridesMock.mockResolvedValueOnce({
      attendees: { x: 1, y: 2, w: 3, h: 4 },
      agenda: { x: 5, y: 6, w: 7, h: 8 },
    })
    const out = await buildAdjustInitialProps({
      template: {
        fields: BUILTIN_FAMILY_MEETING_FIELDS,
        fixed_texts: [],
        family_id: null,
        processed_path: 'builtin/family_meeting_processed.docx',
      },
      contentJson: {},
      bboxOverridesRaw: {},
      newFieldsRaw: [],
    })
    expect(loadBuiltinBboxOverridesMock).toHaveBeenCalledWith('family-meeting')
    expect(out.fields.find((f) => f.name === 'attendees')?.bbox).toEqual({
      x: 1,
      y: 2,
      w: 3,
      h: 4,
    })
    expect(out.fields.find((f) => f.name === 'agenda')?.bbox).toEqual({
      x: 5,
      y: 6,
      w: 7,
      h: 8,
    })
  })

  it('builtin テンプレでも未知 processed_path なら bbox JSON を呼ばない', async () => {
    const out = await buildAdjustInitialProps({
      template: {
        fields: BUILTIN_FAMILY_MEETING_FIELDS,
        fixed_texts: [],
        family_id: null,
        processed_path: 'builtin/unknown_processed.docx',
      },
      contentJson: {},
      bboxOverridesRaw: {},
      newFieldsRaw: [],
    })
    expect(loadBuiltinBboxOverridesMock).not.toHaveBeenCalled()
    // bbox を一切確定できない field は fields から脱落する（extractFieldDefs 既存仕様）。
    expect(out.fields).toEqual([])
  })

  it('bboxOverridesRaw（編集差分）が bbox JSON fallback より優先される', async () => {
    loadBuiltinBboxOverridesMock.mockResolvedValueOnce({
      attendees: { x: 1, y: 2, w: 3, h: 4 },
    })
    const out = await buildAdjustInitialProps({
      template: {
        fields: [{ name: 'attendees', label_ja: '参加者' }],
        fixed_texts: [],
        family_id: null,
        processed_path: 'builtin/family_meeting_processed.docx',
      },
      contentJson: {},
      bboxOverridesRaw: { attendees: { x: 99, y: 99, w: 50, h: 50 } },
      newFieldsRaw: [],
    })
    expect(out.fields.find((f) => f.name === 'attendees')?.bbox).toEqual({
      x: 99,
      y: 99,
      w: 50,
      h: 50,
    })
    expect(out.initialOverrides.attendees).toEqual({ x: 99, y: 99, w: 50, h: 50 })
  })

  it('newFieldsRaw が末尾に合流される', async () => {
    const out = await buildAdjustInitialProps({
      template: {
        fields: USER_TEMPLATE_FIELDS,
        fixed_texts: [],
        family_id: 'fam-1',
        processed_path: null,
      },
      contentJson: {},
      bboxOverridesRaw: {},
      newFieldsRaw: [
        {
          name: 'extra_1',
          label: '追加項目',
          type: 'text',
          bbox: { page: 1, x: 0, y: 0, w: 50, h: 20 },
          max_chars: 200,
          font: { family: 'NotoSansJP', size: 12 },
          multiline: false,
          font_size_min: 8,
        },
      ],
    })
    expect(out.fields.map((f) => f.name)).toEqual(['attendees', 'agenda', 'extra_1'])
  })

  it('fixedTextSizesPt を template.fixed_texts から抽出する（不正値は除外）', async () => {
    const out = await buildAdjustInitialProps({
      template: {
        fields: USER_TEMPLATE_FIELDS,
        fixed_texts: [{ font: { size: 14 } }, { font: { size: 'bad' } }, { foo: 1 }],
        family_id: 'fam-1',
        processed_path: null,
      },
      contentJson: {},
      bboxOverridesRaw: {},
      newFieldsRaw: [],
    })
    expect(out.fixedTextSizesPt).toEqual([14])
  })

  it('bbox JSON 読込が throw しても既存挙動を壊さず fallback なしで続行する', async () => {
    loadBuiltinBboxOverridesMock.mockRejectedValueOnce(new Error('fs failure'))
    const out = await buildAdjustInitialProps({
      template: {
        fields: BUILTIN_FAMILY_MEETING_FIELDS,
        fixed_texts: [],
        family_id: null,
        processed_path: 'builtin/family_meeting_processed.docx',
      },
      contentJson: {},
      bboxOverridesRaw: {},
      newFieldsRaw: [],
    })
    expect(out.fields).toEqual([])
  })
})
