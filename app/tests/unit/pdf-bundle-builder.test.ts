/**
 * TemplateBundleBuilder unit test。
 *
 * 検証対象:
 *   - パス A: blankPdfBytes = originalPdfBytes 無加工コピー（バイト一致）
 *   - パス B: blankPdfBytes = applyWhiteout(originalPdfBytes, whiteoutBoxes) 結果
 *   - パス B + boxes=[]: 無加工コピーで進める（防御）
 *   - 各種 validation（PDF 空 / fields 空 / consent 不足 / IDs 不足 / 不正 pathType）
 *   - dbColumns 構造
 *   - blankPdfPath 生成（{family_id}/{template_id}_blank.pdf）
 */
import { describe, it, expect } from 'vitest'
import {
  buildTemplateBundle,
  type TemplateBundleInput,
} from '@/lib/parsers/pdf/bundle-builder'
import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'
import type { WhiteoutBox } from '@/lib/parsers/pdf/whiteout-pipeline'

async function makeBlankPdf(): Promise<Uint8Array> {
  const { PDFDocument } = await import('pdf-lib')
  const pdf = await PDFDocument.create()
  pdf.addPage([595, 842])
  return await pdf.save()
}

const SAMPLE_FIELD: PdfField = {
  name: 'busho',
  label: '部署',
  type: 'text',
  bbox: { page: 1, x: 60, y: 100, w: 200, h: 24 },
  max_chars: 40,
  font: { family: 'Noto Sans JP', size: 12 },
  padding: { left: 4, top: 4, right: 4, bottom: 4 },
  multiline: false,
  align: 'left',
  vertical: 'top',
  writing_mode: 'horizontal',
  overflow_strategy: 'shrink_then_wrap',
  font_size_min: 8,
}

const COMMON_INPUT_BASE = {
  inputPathType: 'A' as const,
  fields: [SAMPLE_FIELD],
  licenseConsent: {
    user_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    agreed_at: '2026-05-24T00:00:00Z',
  },
  familyId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  templateId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
}

describe('buildTemplateBundle - パス A（無加工コピー）', () => {
  it('blankPdfBytes は originalPdfBytes とバイト一致', async () => {
    const original = await makeBlankPdf()
    const input: TemplateBundleInput = {
      ...COMMON_INPUT_BASE,
      originalPdfBytes: original,
      inputPathType: 'A',
    }
    const bundle = await buildTemplateBundle(input)
    expect(bundle.blankPdfBytes.byteLength).toBe(original.byteLength)
    // 内容も完全一致
    for (let i = 0; i < original.byteLength; i++) {
      if (bundle.blankPdfBytes[i] !== original[i]) {
        throw new Error(`byte mismatch at index ${i}`)
      }
    }
  })

  it('blankPdfBytes は別インスタンス（参照分離）', async () => {
    const original = await makeBlankPdf()
    const bundle = await buildTemplateBundle({
      ...COMMON_INPUT_BASE,
      originalPdfBytes: original,
      inputPathType: 'A',
    })
    expect(bundle.blankPdfBytes).not.toBe(original)
    // 原本を変更しても bundle に影響なし
    original[0] = 0xff
    expect(bundle.blankPdfBytes[0]).not.toBe(0xff)
  })

  it('dbColumns 構造（マイグレ後カラムと一致）', async () => {
    const bundle = await buildTemplateBundle({
      ...COMMON_INPUT_BASE,
      originalPdfBytes: await makeBlankPdf(),
      inputPathType: 'A',
    })
    expect(bundle.dbColumns.input_path_type).toBe('A')
    expect(bundle.dbColumns.background_pdf_path).toBe(
      `${COMMON_INPUT_BASE.familyId}/${COMMON_INPUT_BASE.templateId}_blank.pdf`,
    )
    expect(bundle.dbColumns.fields).toEqual([SAMPLE_FIELD])
    expect(bundle.dbColumns.license_consent).toEqual(COMMON_INPUT_BASE.licenseConsent)
  })
})

describe('buildTemplateBundle - パス B（applyWhiteout）', () => {
  it('boxes 指定ありで blankPdfBytes は applyWhiteout 結果（原本より bytes 増）', async () => {
    const original = await makeBlankPdf()
    const boxes: WhiteoutBox[] = [
      {
        page: 1,
        bbox: { x: 100, y: 200, w: 200, h: 50 },
        estimatedBgColor: { r: 255, g: 255, b: 255 },
        source: 'manual',
      },
    ]
    const bundle = await buildTemplateBundle({
      ...COMMON_INPUT_BASE,
      originalPdfBytes: original,
      inputPathType: 'B',
      whiteoutBoxes: boxes,
    })
    expect(bundle.dbColumns.input_path_type).toBe('B')
    expect(bundle.blankPdfBytes.byteLength).toBeGreaterThan(original.byteLength)
  })

  it('boxes=[] / undefined の場合は防御で無加工コピー', async () => {
    const original = await makeBlankPdf()
    const bundle = await buildTemplateBundle({
      ...COMMON_INPUT_BASE,
      originalPdfBytes: original,
      inputPathType: 'B',
      whiteoutBoxes: [],
    })
    expect(bundle.blankPdfBytes.byteLength).toBe(original.byteLength)
  })
})

describe('buildTemplateBundle - validation', () => {
  it('PDF 空ならエラー', async () => {
    await expect(
      buildTemplateBundle({
        ...COMMON_INPUT_BASE,
        originalPdfBytes: new Uint8Array(0),
      }),
    ).rejects.toThrow('TEMPLATE_BUNDLE_EMPTY_PDF')
  })

  it('fields 空ならエラー', async () => {
    await expect(
      buildTemplateBundle({
        ...COMMON_INPUT_BASE,
        originalPdfBytes: await makeBlankPdf(),
        fields: [],
      }),
    ).rejects.toThrow('TEMPLATE_BUNDLE_EMPTY_FIELDS')
  })

  it('license_consent 不足ならエラー', async () => {
    await expect(
      buildTemplateBundle({
        ...COMMON_INPUT_BASE,
        originalPdfBytes: await makeBlankPdf(),
        licenseConsent: { user_id: '', agreed_at: '' },
      }),
    ).rejects.toThrow('TEMPLATE_BUNDLE_LICENSE_CONSENT_REQUIRED')
  })

  it('familyId / templateId 不足ならエラー', async () => {
    await expect(
      buildTemplateBundle({
        ...COMMON_INPUT_BASE,
        originalPdfBytes: await makeBlankPdf(),
        familyId: '',
      }),
    ).rejects.toThrow('TEMPLATE_BUNDLE_MISSING_IDS')
  })

  it('不正な inputPathType はエラー', async () => {
    await expect(
      buildTemplateBundle({
        ...COMMON_INPUT_BASE,
        originalPdfBytes: await makeBlankPdf(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        inputPathType: 'X' as any,
      }),
    ).rejects.toThrow('TEMPLATE_BUNDLE_INVALID_PATH_TYPE')
  })
})
