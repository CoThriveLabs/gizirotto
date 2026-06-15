import { describe, it, expect } from 'vitest'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import {
  whiteoutBoxToPxRect,
  compositeWhiteoutOnPng,
} from '@/lib/parsers/pdf/whiteout-composite'
import type { RasterizedPage } from '@/lib/parsers/pdf/pdf-page-rasterizer'
import type { WhiteoutBox } from '@/lib/parsers/pdf/whiteout-pipeline'
import { pxToPtX, pxToPtY, type PageMeta } from '@/lib/pdf-output/bbox-coords'

/** 単色塗りつぶしの PNG バイトを作る（テスト用の raw 背景ページ相当）。 */
function makeSolidPng(
  w: number,
  h: number,
  rgb: { r: number; g: number; b: number },
): Uint8Array {
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`
  ctx.fillRect(0, 0, w, h)
  return canvas.toBuffer('image/png')
}

/** RasterizedPage を組み立てる（pngBuffer は makeSolidPng で生成）。 */
function makePage(opts: {
  page: number
  pixelWidth: number
  pixelHeight: number
  widthPt: number
  heightPt: number
  bg?: { r: number; g: number; b: number }
}): RasterizedPage {
  const bg = opts.bg ?? { r: 0, g: 0, b: 0 } // 既定は黒地（白塗りの効果が見えやすい）
  return {
    page: opts.page,
    pngBuffer: makeSolidPng(opts.pixelWidth, opts.pixelHeight, bg),
    pixelWidth: opts.pixelWidth,
    pixelHeight: opts.pixelHeight,
    pagePtSize: { page: opts.page, width: opts.widthPt, height: opts.heightPt },
    scale: opts.pixelWidth / opts.widthPt,
  }
}

/** PNG バイトをデコードして指定 px の RGBA を読む。 */
async function pixelAt(
  png: Uint8Array,
  x: number,
  y: number,
): Promise<{ r: number; g: number; b: number; a: number }> {
  const img = await loadImage(png)
  const canvas = createCanvas(img.width, img.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)
  const d = ctx.getImageData(x, y, 1, 1).data
  return { r: d[0], g: d[1], b: d[2], a: d[3] }
}

const WHITE = { r: 255, g: 255, b: 255 }

function box(
  page: number,
  x: number,
  y: number,
  w: number,
  h: number,
  bg = WHITE,
): WhiteoutBox {
  return {
    page,
    bbox: { x, y, w, h },
    estimatedBgColor: bg,
    source: 'manual',
  }
}

describe('whiteoutBoxToPxRect（pt→px 純関数）', () => {
  it('scale=2（pixel=2×pt）で位置・サイズを 2 倍に変換する', () => {
    const b = box(1, 10, 20, 30, 40)
    const rect = whiteoutBoxToPxRect(b, 1190, 1684, 595, 842) // A4 相当 ×2
    expect(rect.x).toBeCloseTo(10 * (1190 / 595), 6) // = 20
    expect(rect.y).toBeCloseTo(20 * (1684 / 842), 6) // = 40
    expect(rect.w).toBeCloseTo(30 * (1190 / 595), 6) // = 60
    expect(rect.h).toBeCloseTo(40 * (1684 / 842), 6) // = 80
  })

  it('estimatedBgColor を rgb にそのまま反映する', () => {
    const b = box(1, 0, 0, 10, 10, { r: 12, g: 34, b: 56 })
    const rect = whiteoutBoxToPxRect(b, 100, 100, 100, 100)
    expect(rect).toMatchObject({ r: 12, g: 34, b: 56 })
  })

  it('横と縦で異なるスケールを独立に適用する（非正方ページ）', () => {
    const b = box(1, 50, 50, 10, 10)
    const rect = whiteoutBoxToPxRect(b, 800, 200, 400, 400) // sx=2, sy=0.5
    expect(rect.x).toBeCloseTo(100, 6)
    expect(rect.y).toBeCloseTo(25, 6)
    expect(rect.w).toBeCloseTo(20, 6)
    expect(rect.h).toBeCloseTo(5, 6)
  })
})

describe('whiteoutBoxToPxRect ⇔ bbox-coords 往復一致', () => {
  // 再合成の sx/sy は bbox-coords の pxToPtX/Y（widthPt/pixelWidth）の逆数であるべき。
  // px → pt（bbox-coords）→ px（再合成）で元の px に戻ることを確認する（座標系の単一化担保）。
  it('px → pt → px が元の px に一致する', () => {
    const meta: PageMeta = {
      page: 1,
      widthPt: 595,
      heightPt: 842,
      pixelWidth: 1190,
      pixelHeight: 1684,
    }
    const srcPxX = 123
    const srcPxY = 456
    const srcPxW = 78
    const srcPxH = 90

    // px → pt（bbox-coords の純関数）
    const ptX = srcPxX * pxToPtX(meta)
    const ptY = srcPxY * pxToPtY(meta)
    const ptW = srcPxW * pxToPtX(meta)
    const ptH = srcPxH * pxToPtY(meta)

    // pt → px（再合成の純関数）
    const rect = whiteoutBoxToPxRect(
      box(1, ptX, ptY, ptW, ptH),
      meta.pixelWidth,
      meta.pixelHeight,
      meta.widthPt,
      meta.heightPt,
    )

    expect(rect.x).toBeCloseTo(srcPxX, 6)
    expect(rect.y).toBeCloseTo(srcPxY, 6)
    expect(rect.w).toBeCloseTo(srcPxW, 6)
    expect(rect.h).toBeCloseTo(srcPxH, 6)
  })
})

describe('compositeWhiteoutOnPng（実合成）', () => {
  it('boxes が空なら元 PNG をそのまま返す（無変化・同一参照）', async () => {
    const page = makePage({
      page: 1,
      pixelWidth: 40,
      pixelHeight: 40,
      widthPt: 40,
      heightPt: 40,
    })
    const out = await compositeWhiteoutOnPng(page, [])
    expect(out).toBe(page.pngBuffer)
  })

  it('当該ページに該当 box が無ければ無変化で返す（別 page の box は無視）', async () => {
    const page = makePage({
      page: 1,
      pixelWidth: 40,
      pixelHeight: 40,
      widthPt: 40,
      heightPt: 40,
    })
    const out = await compositeWhiteoutOnPng(page, [box(2, 0, 0, 10, 10)])
    expect(out).toBe(page.pngBuffer)
  })

  it('黒地に白 box を再合成すると矩形内が白・外が黒のまま（位置/サイズ正）', async () => {
    // pt=px（scale=1）の 100×100 黒地。pt(10,20,30,40) を白塗り。
    const page = makePage({
      page: 1,
      pixelWidth: 100,
      pixelHeight: 100,
      widthPt: 100,
      heightPt: 100,
      bg: { r: 0, g: 0, b: 0 },
    })
    const out = await compositeWhiteoutOnPng(page, [box(1, 10, 20, 30, 40, WHITE)])

    // 矩形内（中心 25,40）は白。
    const inside = await pixelAt(out, 25, 40)
    expect(inside).toMatchObject({ r: 255, g: 255, b: 255 })

    // 矩形外（左上 2,2）は黒のまま。
    const outsideTL = await pixelAt(out, 2, 2)
    expect(outsideTL).toMatchObject({ r: 0, g: 0, b: 0 })

    // 矩形外（右下 90,90）は黒のまま。
    const outsideBR = await pixelAt(out, 90, 90)
    expect(outsideBR).toMatchObject({ r: 0, g: 0, b: 0 })

    // 矩形左端の手前（x=9）は黒、右端 of box は x<40 が白（x=39 内・x=41 外）。
    expect(await pixelAt(out, 9, 30)).toMatchObject({ r: 0, g: 0, b: 0 })
    expect(await pixelAt(out, 11, 30)).toMatchObject({ r: 255, g: 255, b: 255 })
    expect(await pixelAt(out, 39, 30)).toMatchObject({ r: 255, g: 255, b: 255 })
    expect(await pixelAt(out, 41, 30)).toMatchObject({ r: 0, g: 0, b: 0 })
  })

  it('scale=2（pt の 2 倍解像度）でも px 換算した正しい位置に塗る', async () => {
    // 200×200 px = 100×100 pt（sx=sy=2）。pt(10,10,20,20) → px(20,20,40,40)。
    const page = makePage({
      page: 1,
      pixelWidth: 200,
      pixelHeight: 200,
      widthPt: 100,
      heightPt: 100,
      bg: { r: 0, g: 0, b: 0 },
    })
    const out = await compositeWhiteoutOnPng(page, [box(1, 10, 10, 20, 20, WHITE)])
    // 矩形中心 px(40,40) は白。
    expect(await pixelAt(out, 40, 40)).toMatchObject({ r: 255, g: 255, b: 255 })
    // px(19,19) は矩形外（pt 9.5 相当）→ 黒。
    expect(await pixelAt(out, 19, 19)).toMatchObject({ r: 0, g: 0, b: 0 })
    // px(59,59) は矩形外（右下 px40+40=60 の外）→ 黒。
    expect(await pixelAt(out, 62, 62)).toMatchObject({ r: 0, g: 0, b: 0 })
  })

  it('estimatedBgColor の色で塗る（白以外も反映）', async () => {
    const page = makePage({
      page: 1,
      pixelWidth: 50,
      pixelHeight: 50,
      widthPt: 50,
      heightPt: 50,
      bg: { r: 0, g: 0, b: 0 },
    })
    const out = await compositeWhiteoutOnPng(page, [
      box(1, 5, 5, 20, 20, { r: 10, g: 200, b: 30 }),
    ])
    expect(await pixelAt(out, 15, 15)).toMatchObject({ r: 10, g: 200, b: 30 })
  })

  it('同一ページに複数 box を全て塗る', async () => {
    const page = makePage({
      page: 1,
      pixelWidth: 100,
      pixelHeight: 100,
      widthPt: 100,
      heightPt: 100,
      bg: { r: 0, g: 0, b: 0 },
    })
    const out = await compositeWhiteoutOnPng(page, [
      box(1, 5, 5, 10, 10, WHITE),
      box(1, 50, 50, 10, 10, { r: 0, g: 0, b: 255 }),
    ])
    expect(await pixelAt(out, 10, 10)).toMatchObject({ r: 255, g: 255, b: 255 })
    expect(await pixelAt(out, 55, 55)).toMatchObject({ r: 0, g: 0, b: 255 })
    // どちらの box にも属さない領域は黒のまま。
    expect(await pixelAt(out, 30, 30)).toMatchObject({ r: 0, g: 0, b: 0 })
  })

  it('複数ページ渡しでも当該 page の box だけを塗る', async () => {
    const page2 = makePage({
      page: 2,
      pixelWidth: 60,
      pixelHeight: 60,
      widthPt: 60,
      heightPt: 60,
      bg: { r: 0, g: 0, b: 0 },
    })
    // page1 用の box は無視され、page2 の box(10,10,20,20) のみ塗られる。
    const out = await compositeWhiteoutOnPng(page2, [
      box(1, 0, 0, 60, 60, WHITE),
      box(2, 10, 10, 20, 20, WHITE),
    ])
    expect(await pixelAt(out, 20, 20)).toMatchObject({ r: 255, g: 255, b: 255 })
    expect(await pixelAt(out, 50, 50)).toMatchObject({ r: 0, g: 0, b: 0 })
  })
})
