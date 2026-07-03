/**
 * renderRawPdfWithWhiteoutToImages の unit。
 *
 * 白塗りテンプレの render-image 経路が _blank.pdf を rasterize せず、raw 背景 + 白塗り PNG
 * 再合成で画像化することを検証する。合成失敗時は素の raw を出さず throw（個人情報死守）。
 *
 * 重い worker spawn を避けるため renderPdfPagesToPng / compositeWhiteoutOnPng をモックする。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import JSZip from 'jszip'

const rasterMock = vi.fn()
const compositeMock = vi.fn()

vi.mock('@/lib/parsers/pdf/pdf-page-rasterizer', () => ({
  renderPdfPagesToPng: (...args: unknown[]) => rasterMock(...args),
}))
vi.mock('@/lib/parsers/pdf/whiteout-composite', () => ({
  compositeWhiteoutOnPng: (...args: unknown[]) => compositeMock(...args),
}))

import { renderRawPdfWithWhiteoutToImages } from '@/lib/pdf-output/image-render-raw-overlay'
import type { WhiteoutBox } from '@/lib/parsers/pdf/whiteout-pipeline'

const RAW = new Uint8Array([1, 2, 3])

function page(p: number) {
  return {
    page: p,
    pngBuffer: new Uint8Array([p]),
    pixelWidth: 100,
    pixelHeight: 200,
    pagePtSize: { page: p, width: 50, height: 100 },
    scale: 2,
  }
}

const BOX: WhiteoutBox = {
  page: 1,
  bbox: { x: 1, y: 2, w: 3, h: 4 },
  estimatedBgColor: { r: 255, g: 255, b: 255 },
  source: 'manual',
}

describe('renderRawPdfWithWhiteoutToImages', () => {
  beforeEach(() => {
    rasterMock.mockReset()
    compositeMock.mockReset()
  })

  it('単一ページ: raw を rasterize → 白塗り合成 → png 返却（_blank.pdf は使わない）', async () => {
    rasterMock.mockResolvedValue([page(1)])
    compositeMock.mockResolvedValue(new Uint8Array([42]))

    const res = await renderRawPdfWithWhiteoutToImages({
      rawPdfBytes: RAW,
      whiteoutBoxes: [BOX],
      requestedDpi: 150,
      format: 'png',
      asZip: false,
    })

    // scale=dpi/72 で raw をラスタライズしている
    expect(rasterMock).toHaveBeenCalledTimes(1)
    const [, opts] = rasterMock.mock.calls[0]
    expect((opts as { scale: number }).scale).toBeCloseTo(150 / 72)
    // 合成が呼ばれ、その結果が返る（素 raw pngBuffer ではない）
    expect(compositeMock).toHaveBeenCalledTimes(1)
    expect(res.contentType).toBe('image/png')
    expect(res.ext).toBe('png')
    expect(res.renderedPages).toBe(1)
    expect(Array.from(res.bytes)).toEqual([42])
    expect(res.dpiDecision.dpi).toBe(150)
    expect(res.dpiDecision.downgraded).toBe(false)
  })

  it('複数ページ: 全ページ合成して ZIP 返却', async () => {
    rasterMock.mockResolvedValue([page(1), page(2)])
    compositeMock.mockImplementation((p: { page: number }) =>
      Promise.resolve(new Uint8Array([100 + p.page])),
    )

    const res = await renderRawPdfWithWhiteoutToImages({
      rawPdfBytes: RAW,
      whiteoutBoxes: [BOX],
      requestedDpi: 150,
      format: 'png',
      asZip: false,
    })

    expect(res.ext).toBe('zip')
    expect(res.contentType).toBe('application/zip')
    expect(res.renderedPages).toBe(2)
    expect(compositeMock).toHaveBeenCalledTimes(2)
    // ZIP 内に 2 ページ分の png が入る
    const zip = await JSZip.loadAsync(res.bytes)
    expect(Object.keys(zip.files).sort()).toEqual([
      'page_001.png',
      'page_002.png',
    ])
  })

  it('pageRange: 指定範囲のみ合成（範囲外ページは合成しない）', async () => {
    rasterMock.mockResolvedValue([page(1), page(2), page(3)])
    compositeMock.mockImplementation((p: { page: number }) =>
      Promise.resolve(new Uint8Array([p.page])),
    )

    const res = await renderRawPdfWithWhiteoutToImages({
      rawPdfBytes: RAW,
      whiteoutBoxes: [BOX],
      pageRange: { from: 2, to: 2 },
      requestedDpi: 72,
      format: 'png',
      asZip: false,
    })

    // 範囲が 1 ページなので単一 png
    expect(res.ext).toBe('png')
    expect(res.renderedPages).toBe(1)
    expect(compositeMock).toHaveBeenCalledTimes(1)
    const [arg] = compositeMock.mock.calls[0]
    expect((arg as { page: number }).page).toBe(2)
  })

  it('合成失敗時: 素の raw を出力せず throw（個人情報死守）', async () => {
    rasterMock.mockResolvedValue([page(1)])
    compositeMock.mockRejectedValue(new Error('composite boom'))

    await expect(
      renderRawPdfWithWhiteoutToImages({
        rawPdfBytes: RAW,
        whiteoutBoxes: [BOX],
        requestedDpi: 150,
        format: 'png',
        asZip: false,
      }),
    ).rejects.toThrow('composite boom')
  })

  it('jpeg 要求でも合成は png で返す（漏洩経路を増やさない）', async () => {
    rasterMock.mockResolvedValue([page(1)])
    compositeMock.mockResolvedValue(new Uint8Array([7]))

    const res = await renderRawPdfWithWhiteoutToImages({
      rawPdfBytes: RAW,
      whiteoutBoxes: [BOX],
      requestedDpi: 150,
      format: 'jpeg',
      asZip: false,
    })

    expect(res.contentType).toBe('image/png')
    expect(res.ext).toBe('png')
  })

  it('ページ 0 件: throw', async () => {
    rasterMock.mockResolvedValue([])

    await expect(
      renderRawPdfWithWhiteoutToImages({
        rawPdfBytes: RAW,
        whiteoutBoxes: [BOX],
        requestedDpi: 150,
        format: 'png',
        asZip: false,
      }),
    ).rejects.toThrow('IMAGE_RENDER_NO_PAGES')
  })
})
