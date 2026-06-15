/**
 * SimplePdfGenerator unit test。
 *
 * 検証対象:
 *   - generateSimplePdf: items から A4 PDF を生成、Uint8Array を返す
 *   - 空 items はエラー（SIMPLE_PDF_NO_ITEMS）
 *   - title あり / なし両対応
 *   - 長文 value は文字単位で折り返し
 *   - ページオーバーフローで新ページ追加
 *
 * 実フォント（Noto Sans CJK JP, 16MB）を embed するため、
 * テスト時はフォントファイルの存在確認 + skipIf でスキップ。
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { generateSimplePdf } from '@/lib/pdf-output/simple-pdf-generator'

const FONT_PATH = resolve(
  process.cwd(),
  'assets/fonts/NotoSansCJKjp-Regular.otf',
)
const haveFont = existsSync(FONT_PATH)

describe.skipIf(!haveFont)('SimplePdfGenerator', () => {
  it('items 1 件から PDF を生成（Uint8Array、PDF magic 確認）', async () => {
    const bytes = await generateSimplePdf({
      items: [{ label: '日時', value: '2026年5月24日 14時00分' }],
    })
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.byteLength).toBeGreaterThan(1000) // フォント埋込みあり
    // PDF magic: '%PDF-'
    const head = Buffer.from(bytes).subarray(0, 5).toString('latin1')
    expect(head).toBe('%PDF-')
  }, 30_000)

  it('title あり + 複数 items', async () => {
    const bytes = await generateSimplePdf({
      title: '第 5 回 家族会議 議事録',
      items: [
        { label: '日時', value: '2026年5月24日' },
        { label: '場所', value: 'リビング' },
        { label: '議題', value: '春休みの予定' },
      ],
    })
    expect(bytes.byteLength).toBeGreaterThan(2000)
  }, 30_000)

  it('長文 value は文字単位で改行（PDF が生成される）', async () => {
    const longText = 'あ'.repeat(500)
    const bytes = await generateSimplePdf({
      items: [{ label: '議事内容', value: longText }],
    })
    expect(bytes.byteLength).toBeGreaterThan(0)
  }, 30_000)

  it('value 内の "\\n" は改行として扱う', async () => {
    const bytes = await generateSimplePdf({
      items: [{ label: '決定事項', value: '1. 次回 6/7\n2. 場所 リビング' }],
    })
    expect(bytes.byteLength).toBeGreaterThan(0)
  }, 30_000)

  it('ページオーバーフロー: 大量 items でも例外なく完走', async () => {
    const items = Array.from({ length: 80 }, (_, i) => ({
      label: `項目${i + 1}`,
      value: 'テキスト'.repeat(20),
    }))
    const bytes = await generateSimplePdf({ items })
    expect(bytes.byteLength).toBeGreaterThan(0)
  }, 60_000)

  it('items 空はエラー (SIMPLE_PDF_NO_ITEMS)', async () => {
    await expect(generateSimplePdf({ items: [] })).rejects.toThrow(
      'SIMPLE_PDF_NO_ITEMS',
    )
  })

  it('options.fontSize で本文サイズ変更可', async () => {
    const bytes = await generateSimplePdf(
      { items: [{ label: 'a', value: 'b' }] },
      { fontSize: 16 },
    )
    expect(bytes.byteLength).toBeGreaterThan(0)
  }, 30_000)
})
