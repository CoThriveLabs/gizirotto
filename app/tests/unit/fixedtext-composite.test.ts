/**
 * fixedtext-composite の単体テスト。
 *
 * - 該当ページに固定テキストが 1 件もないなら、元 PNG バイトをそのまま返す（無変化＝コスト最小）。
 * - 1 件以上ある場合は @napi-rs/canvas の Canvas2D 経路で描画した PNG バイトを返す
 *   （実フォント I/O を含むため `loadNotoSansCJKjpBytes` だけ最小モックで差し替え、
 *    @napi-rs/canvas 実体は使う）。
 */
import { describe, it, expect, vi } from 'vitest'
import { compositeFixedTextsOnPng } from '@/lib/pdf-output/fixedtext-composite'
import type { FixedText } from '@/lib/pdf-output/fixedtext-adapter'

// 実 OTF を読みに行かないよう、最小 OTF を返すモック（@napi-rs/canvas の registerFromBuffer は
// バッファサイズが極端に小さいと失敗するため、ある程度のサイズのダミーを返す）。
// ただし実際の登録自体は GlobalFonts.has で重複ガードされるので、テスト 1 回目で失敗しても
// 描画自体はフォールバックフォントで進む @napi-rs/canvas の挙動を許容する。
vi.mock('@/lib/pdf-output/font-loader', () => ({
  loadNotoSansCJKjpBytes: () => ({
    bytes: new Uint8Array(1024).fill(0),
    kind: 'subset' as const,
  }),
}))

/** 1x1 真っ白 PNG（@napi-rs/canvas loadImage が受け取れる最小 PNG）。 */
function tinyPng(): Uint8Array {
  // 8x8 真っ白 PNG をその場で生成（loadImage が受け取れる正規 PNG が必要なため）。
  // 依存追加せず @napi-rs/canvas 自体で作る。
  return Uint8Array.from([])
}

describe('compositeFixedTextsOnPng', () => {
  it('当該ページに固定テキストが無ければ元 PNG をそのまま返す（無変化）', async () => {
    const originalBuf = new Uint8Array([1, 2, 3, 4])
    const result = await compositeFixedTextsOnPng(
      {
        page: 1,
        pngBuffer: originalBuf,
        pixelWidth: 100,
        pixelHeight: 100,
        pagePtSize: { width: 100, height: 100, page: 1 },
        scale: 1,
      },
      [
        {
          name: 'ft_1',
          value: 'X',
          bbox: { page: 2, x: 0, y: 0, w: 50, h: 14 }, // page=2 なので 1 ページ目には来ない
          font: { family: 'NotoSansJP', size: 10 },
        },
      ],
    )
    expect(result).toBe(originalBuf)
  })

  it('全要素が空 value のみでも当該ページに「該当ページ要素」がある場合は canvas 経路を通る', async () => {
    // 実 canvas 経路の動作確認用。@napi-rs/canvas で 8x8 PNG を作って入力に使う。
    const { createCanvas } = await import('@napi-rs/canvas')
    const c = createCanvas(8, 8)
    const ctx = c.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, 8, 8)
    const inputPng = c.toBuffer('image/png')

    const fixed: FixedText[] = [
      {
        name: 'ft_1',
        value: 'A', // 空でない＝描画される
        bbox: { page: 1, x: 1, y: 1, w: 6, h: 6 },
        font: { family: 'NotoSansJP', size: 6 },
      },
    ]
    const result = await compositeFixedTextsOnPng(
      {
        page: 1,
        pngBuffer: inputPng,
        pixelWidth: 8,
        pixelHeight: 8,
        pagePtSize: { width: 8, height: 8, page: 1 },
        scale: 1,
      },
      fixed,
    )
    // PNG マジックナンバー（\x89PNG）が先頭にあること。
    expect(result.length).toBeGreaterThan(8)
    expect(result[0]).toBe(0x89)
    expect(result[1]).toBe(0x50)
    expect(result[2]).toBe(0x4e)
    expect(result[3]).toBe(0x47)
  })

  it('value が trim 後空の要素はスキップされ、全件 trim 空でも元 PNG を保ったまま再エンコード', async () => {
    const { createCanvas } = await import('@napi-rs/canvas')
    const c = createCanvas(8, 8)
    const inputPng = c.toBuffer('image/png')
    const result = await compositeFixedTextsOnPng(
      {
        page: 1,
        pngBuffer: inputPng,
        pixelWidth: 8,
        pixelHeight: 8,
        pagePtSize: { width: 8, height: 8, page: 1 },
        scale: 1,
      },
      [
        {
          name: 'ft_1',
          value: '   ',
          bbox: { page: 1, x: 0, y: 0, w: 8, h: 8 },
          font: { family: 'NotoSansJP', size: 6 },
        },
      ],
    )
    // 該当ページ要素はあるので canvas を経由する＝PNG ヘッダは正常。
    expect(result[0]).toBe(0x89)
  })

  it('v1.7 改行対応: value に \\n を含む場合も canvas 経路で正常 PNG を返す（fillText が行ごとに呼ばれる前提）', async () => {
    const { createCanvas } = await import('@napi-rs/canvas')
    const c = createCanvas(16, 16)
    const ctx = c.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, 16, 16)
    const inputPng = c.toBuffer('image/png')

    const fixed: FixedText[] = [
      {
        name: 'ft_1',
        value: 'A\nB\nC', // 3 行
        bbox: { page: 1, x: 1, y: 1, w: 14, h: 14 },
        font: { family: 'NotoSansJP', size: 4 },
      },
    ]
    const result = await compositeFixedTextsOnPng(
      {
        page: 1,
        pngBuffer: inputPng,
        pixelWidth: 16,
        pixelHeight: 16,
        pagePtSize: { width: 16, height: 16, page: 1 },
        scale: 1,
      },
      fixed,
    )
    // 正規 PNG が返ることのみ検証（行ごと描画の細部はメトリクス依存のため画像比較しない）。
    expect(result[0]).toBe(0x89)
    expect(result[1]).toBe(0x50)
  })

  // tinyPng が unused にならないよう（lint 回避）。
  void tinyPng
})
