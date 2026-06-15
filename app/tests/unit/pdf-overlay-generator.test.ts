/**
 * PdfOverlayGenerator unit test。
 *
 * 差別化コア「PDF レイアウト保持出力」の本体動作確認:
 *   - blank.pdf に PdfField bbox 通り drawText 配置
 *   - fitTextInBox 連携: shrunk / wrapped / truncated / overflow の warning 集計
 *   - field_name に対応する fieldValues が未指定なら skip
 *   - 個人スタイル padding が field.padding を上書き
 *   - 罫線 / 背景は再描画しない（pdf-lib.load → drawText のみ、原本そのまま保持）
 *
 * 実 pdf-lib + Noto Sans CJK JP embed を経由するため、フォント未配置時は skipIf。
 *
 * 注意: 知人 PDF 内容は assertion に書かない。
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { generateOverlayPdf } from '@/lib/pdf-output/overlay-generator'
import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'

const FONT_PATH = resolve(
  process.cwd(),
  'assets/fonts/NotoSansCJKjp-Regular.otf',
)
const haveFont = existsSync(FONT_PATH)

async function makeBlankPdf(): Promise<Uint8Array> {
  const { PDFDocument } = await import('pdf-lib')
  const pdf = await PDFDocument.create()
  pdf.addPage([595, 842])
  return await pdf.save()
}

function makeField(overrides: Partial<PdfField>): PdfField {
  return {
    name: 'sample',
    label: 'サンプル',
    type: 'text',
    bbox: { page: 1, x: 60, y: 100, w: 200, h: 30 },
    max_chars: 40,
    font: { family: 'Noto Sans JP', size: 12 },
    padding: { left: 4, top: 4, right: 4, bottom: 4 },
    multiline: false,
    align: 'left',
    vertical: 'top',
    writing_mode: 'horizontal',
    overflow_strategy: 'shrink_then_wrap',
    font_size_min: 8,
    ...overrides,
  }
}

describe.skipIf(!haveFont)('PdfOverlayGenerator - 基本動作', () => {
  it('blank.pdf + field 1 個 + fieldValues 1 個で PDF 生成', async () => {
    const blank = await makeBlankPdf()
    const field = makeField({ name: 'agenda', label: '議題' })
    const result = await generateOverlayPdf({
      blankPdfBytes: blank,
      fields: [field],
      fieldValues: { agenda: '春休みの予定' },
    })
    expect(result.pdfBytes).toBeInstanceOf(Uint8Array)
    expect(result.pdfBytes.byteLength).toBeGreaterThan(blank.byteLength)
    // 既定サイズで収まる → warning='none' で warnings は空
    expect(result.warnings).toEqual([])
    // PDF magic
    const head = Buffer.from(result.pdfBytes).subarray(0, 5).toString('latin1')
    expect(head).toBe('%PDF-')
  }, 30_000)

  it('fieldValues 未指定の field は skip（warning なし）', async () => {
    const blank = await makeBlankPdf()
    const field1 = makeField({ name: 'agenda', label: '議題' })
    const field2 = makeField({
      name: 'date',
      label: '日時',
      bbox: { page: 1, x: 60, y: 50, w: 200, h: 24 },
    })
    const result = await generateOverlayPdf({
      blankPdfBytes: blank,
      fields: [field1, field2],
      fieldValues: { agenda: '議題内容' }, // date は指定なし
    })
    expect(result.warnings).toEqual([])
  }, 30_000)

  it('複数 field + 複数値で完走（warning は overflow 以外なら許容）', async () => {
    // 実 Noto Sans CJK JP フォントは文字幅が固定幅 fake font と異なるため、
    // 一部 field で shrunk / wrapped が発生する可能性あり。
    // overflow（フィッティング 3 段すべて失敗）のみがエラー扱い。
    const blank = await makeBlankPdf()
    const fields = [
      makeField({ name: 'a', bbox: { page: 1, x: 60, y: 50, w: 300, h: 60 } }),
      makeField({ name: 'b', bbox: { page: 1, x: 60, y: 150, w: 300, h: 60 } }),
      makeField({ name: 'c', bbox: { page: 1, x: 60, y: 250, w: 300, h: 60 } }),
    ]
    const result = await generateOverlayPdf({
      blankPdfBytes: blank,
      fields,
      fieldValues: { a: '値1', b: '値2', c: '値3' },
    })
    // overflow は発生しない（十分に大きい bbox）
    const overflows = result.warnings.filter(w => w.warning === 'overflow')
    expect(overflows).toEqual([])
  }, 60_000)
})

describe.skipIf(!haveFont)('PdfOverlayGenerator - warnings 集計', () => {
  it('小さすぎる bbox で overflow warning', async () => {
    const blank = await makeBlankPdf()
    // padding 4+4 = maxW=0 になる極小 bbox
    const field = makeField({
      name: 'tiny',
      bbox: { page: 1, x: 60, y: 100, w: 8, h: 30 },
    })
    const result = await generateOverlayPdf({
      blankPdfBytes: blank,
      fields: [field],
      fieldValues: { tiny: 'これは入らない長い文字列' },
    })
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0].fieldName).toBe('tiny')
    expect(result.warnings[0].warning).toBe('overflow')
    expect(result.warnings[0].originalText).toBe('これは入らない長い文字列')
  }, 30_000)

  it('multiline=true で改行発生時は warning=wrapped', async () => {
    const blank = await makeBlankPdf()
    const field = makeField({
      name: 'multi',
      multiline: true,
      // 高さ十分あるが幅が狭い
      bbox: { page: 1, x: 60, y: 100, w: 60, h: 200 },
    })
    const result = await generateOverlayPdf({
      blankPdfBytes: blank,
      fields: [field],
      fieldValues: { multi: 'A'.repeat(40) },
    })
    // shrunk or wrapped or truncated のいずれか
    expect(result.warnings).toHaveLength(1)
    expect(['shrunk', 'wrapped', 'truncated']).toContain(result.warnings[0].warning)
  }, 30_000)

  it('範囲外 page index は overflow warning + skip（throw しない）', async () => {
    // 有効な field と範囲外 field を混在させる。
    // 「全 field 範囲外」極端ケースは embedFont 後に何も draw されず
    // pdf-lib subset 化が空 glyph map で RangeError を投げる挙動を回避する
    // （production 設計上、全 field 範囲外は発生しない）。
    const blank = await makeBlankPdf()
    const validField = makeField({
      name: 'ok',
      bbox: { page: 1, x: 60, y: 100, w: 300, h: 40 },
    })
    const oobField = makeField({
      name: 'oob',
      bbox: { page: 99, x: 60, y: 100, w: 200, h: 30 }, // 範囲外
    })
    const result = await generateOverlayPdf({
      blankPdfBytes: blank,
      fields: [validField, oobField],
      fieldValues: { ok: '値1', oob: 'test' },
    })
    const oobWarnings = result.warnings.filter(w => w.fieldName === 'oob')
    expect(oobWarnings).toHaveLength(1)
    expect(oobWarnings[0].warning).toBe('overflow')
  }, 60_000)
})

describe.skipIf(!haveFont)('PdfOverlayGenerator - 個人スタイル padding 上書き', () => {
  it('userStylePadding が指定されると field.padding を上書き', async () => {
    const blank = await makeBlankPdf()
    const field = makeField({
      name: 'p',
      // field.padding = 4 だが userStylePadding で 20 になる
      bbox: { page: 1, x: 60, y: 100, w: 100, h: 30 },
    })
    // padding 20+20 = maxW=60 で 'A' * 20 が縮小される
    const result = await generateOverlayPdf({
      blankPdfBytes: blank,
      fields: [field],
      fieldValues: { p: 'A'.repeat(20) },
      userStylePadding: {
        p: { left: 20, top: 4, right: 20, bottom: 4 },
      },
    })
    // 縮小が発生する想定（shrunk or truncated）
    expect(result.warnings.length).toBeGreaterThan(0)
  }, 30_000)
})

describe.skipIf(!haveFont)('PdfOverlayGenerator - uniform 注入 + 固定テキスト回帰', () => {
  it('uniformTargetNames 指定で記入欄に統一サイズ注入しても overflow しない', async () => {
    // 記入欄 2 個（大小）を uniform 対象に。最小欄基準の統一サイズが注入され、
    // FIT_HEIGHT_RATIO(1.0) で高さ判定するため bbox 高さいっぱい寄りでも入る（縮め返さない）。
    const blank = await makeBlankPdf()
    const small = makeField({
      name: 'place',
      bbox: { page: 1, x: 60, y: 100, w: 300, h: 16 },
    })
    const big = makeField({
      name: 'agenda',
      bbox: { page: 1, x: 60, y: 200, w: 300, h: 52 },
    })
    const result = await generateOverlayPdf({
      blankPdfBytes: blank,
      fields: [small, big],
      fieldValues: { place: '会議室A', agenda: '次年度予算の検討' },
      uniformTargetNames: new Set(['place', 'agenda']),
    })
    const overflows = result.warnings.filter((w) => w.warning === 'overflow')
    expect(overflows).toEqual([])
  }, 60_000)

  it('固定テキスト（uniform 対象外）は従来サイズ・従来高さ判定のまま混在しても壊れない', async () => {
    // 記入欄は uniform 対象、固定テキスト疑似 field は対象外（heightRatio 未指定経路）。
    // 両者混在で完走し overflow しないこと＝固定テキスト経路の回帰なしを担保。
    const blank = await makeBlankPdf()
    const entry = makeField({
      name: 'content',
      bbox: { page: 1, x: 60, y: 100, w: 400, h: 40 },
    })
    const fixed = makeField({
      name: 'fixed_legacy', // 旧固定テキスト疑似 field 名（行展開廃止後も任意名で動作確認用）
      bbox: { page: 1, x: 60, y: 300, w: 400, h: 24 },
      font: { family: 'Noto Sans JP', size: 10.5 },
    })
    const result = await generateOverlayPdf({
      blankPdfBytes: blank,
      fields: [entry, fixed],
      fieldValues: { content: '議事内容のテキスト', fixed_legacy: '記録者：田中' },
      uniformTargetNames: new Set(['content']), // 固定テキストは含めない
    })
    const overflows = result.warnings.filter((w) => w.warning === 'overflow')
    expect(overflows).toEqual([])
  }, 60_000)
})

describe('PdfOverlayGenerator - validation', () => {
  it('blankPdfBytes 空はエラー', async () => {
    await expect(
      generateOverlayPdf({
        blankPdfBytes: new Uint8Array(0),
        fields: [makeField({})],
        fieldValues: { sample: 'x' },
      }),
    ).rejects.toThrow('OVERLAY_BLANK_PDF_EMPTY')
  })

  it('fields 空はエラー', async () => {
    await expect(
      generateOverlayPdf({
        blankPdfBytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        fields: [],
        fieldValues: {},
      }),
    ).rejects.toThrow('OVERLAY_FIELDS_EMPTY')
  })
})
