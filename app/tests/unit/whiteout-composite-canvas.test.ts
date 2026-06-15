import { describe, it, expect } from 'vitest'
import { createCanvas, loadImage } from '@napi-rs/canvas'
// 座標式は共有モジュール whiteout-coords から取る（クライアント canvas 版と同一の import 経路）。
import { whiteoutBoxToPxRect } from '@/lib/parsers/pdf/whiteout-coords'
import { compositeWhiteoutOnCanvas } from '@/lib/preview/whiteout-composite-canvas'
import type { WhiteoutBox } from '@/lib/parsers/pdf/whiteout-pipeline'

/** 単色 PNG（raw 背景相当）を作る。 */
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

const WHITE = { r: 255, g: 255, b: 255 }

function box(
  page: number,
  x: number,
  y: number,
  w: number,
  h: number,
  bg = WHITE,
): WhiteoutBox {
  return { page, bbox: { x, y, w, h }, estimatedBgColor: bg, source: 'manual' }
}

/**
 * @napi-rs/canvas の Canvas は getContext('2d')/drawImage/fillRect/clearRect を持ち、
 * ブラウザ HTMLCanvasElement と構造的に同型。compositeWhiteoutOnCanvas はそれらしか
 * 使わないので、ここでは napi canvas を HTMLCanvasElement として渡して描画結果を検証する。
 */
async function renderCanvas(
  pixelWidth: number,
  pixelHeight: number,
  widthPt: number,
  heightPt: number,
  bg: { r: number; g: number; b: number },
  boxes: WhiteoutBox[],
) {
  const rawPng = makeSolidPng(pixelWidth, pixelHeight, bg)
  const rawImg = await loadImage(rawPng)
  const canvas = createCanvas(pixelWidth, pixelHeight)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  compositeWhiteoutOnCanvas(
    canvas as unknown as HTMLCanvasElement,
    rawImg as unknown as CanvasImageSource,
    boxes,
    pixelWidth,
    pixelHeight,
    widthPt,
    heightPt,
  )
  const ctx = canvas.getContext('2d')
  return (x: number, y: number) => {
    const d = ctx.getImageData(x, y, 1, 1).data
    return { r: d[0], g: d[1], b: d[2], a: d[3] }
  }
}

describe('compositeWhiteoutOnCanvas（ブラウザ Canvas2D 版）', () => {
  it('boxes 空なら raw をそのまま描く（白塗りなし＝全面 raw 色）', async () => {
    const at = await renderCanvas(40, 40, 40, 40, { r: 0, g: 0, b: 0 }, [])
    expect(at(20, 20)).toMatchObject({ r: 0, g: 0, b: 0 })
  })

  it('黒地に白 box を合成すると矩形内が白・外が黒（位置/サイズ正）', async () => {
    const at = await renderCanvas(100, 100, 100, 100, { r: 0, g: 0, b: 0 }, [
      box(1, 10, 20, 30, 40, WHITE),
    ])
    expect(at(25, 40)).toMatchObject({ r: 255, g: 255, b: 255 }) // 矩形内
    expect(at(2, 2)).toMatchObject({ r: 0, g: 0, b: 0 }) // 外
    expect(at(9, 30)).toMatchObject({ r: 0, g: 0, b: 0 }) // 左端手前
    expect(at(11, 30)).toMatchObject({ r: 255, g: 255, b: 255 })
    expect(at(39, 30)).toMatchObject({ r: 255, g: 255, b: 255 })
    expect(at(41, 30)).toMatchObject({ r: 0, g: 0, b: 0 })
  })

  it('scale=2（pt の 2 倍解像度）でも px 換算した正しい位置に塗る', async () => {
    const at = await renderCanvas(200, 200, 100, 100, { r: 0, g: 0, b: 0 }, [
      box(1, 10, 10, 20, 20, WHITE),
    ])
    expect(at(40, 40)).toMatchObject({ r: 255, g: 255, b: 255 })
    expect(at(19, 19)).toMatchObject({ r: 0, g: 0, b: 0 })
  })

  it('estimatedBgColor の色で塗る（白以外も反映）', async () => {
    const at = await renderCanvas(50, 50, 50, 50, { r: 0, g: 0, b: 0 }, [
      box(1, 5, 5, 20, 20, { r: 10, g: 200, b: 30 }),
    ])
    expect(at(15, 15)).toMatchObject({ r: 10, g: 200, b: 30 })
  })
})

describe('canvas 合成 ⇔ サーバ焼込 の座標一致（whiteoutBoxToPxRect 共有）', () => {
  // クライアント canvas とサーバ焼込が**同一の whiteoutBoxToPxRect** を使うことを、
  // 「テストが import した純関数で算出した矩形」と「canvas 描画結果の白/黒境界」で照合する。
  // 式が二重定義されてズレると、この境界チェックが落ちる（§2-3 / §10 のズレ検知）。
  it('純関数が示す矩形境界と canvas 描画の白/黒境界が一致する', async () => {
    const pixelWidth = 595
    const pixelHeight = 842
    const widthPt = 595
    const heightPt = 842
    const b = box(1, 100.5, 200.25, 80, 60, WHITE)
    const rect = whiteoutBoxToPxRect(b, pixelWidth, pixelHeight, widthPt, heightPt)

    const at = await renderCanvas(
      pixelWidth,
      pixelHeight,
      widthPt,
      heightPt,
      { r: 0, g: 0, b: 0 },
      [b],
    )

    // 矩形中心は白。
    const cx = Math.round(rect.x + rect.w / 2)
    const cy = Math.round(rect.y + rect.h / 2)
    expect(at(cx, cy)).toMatchObject({ r: 255, g: 255, b: 255 })

    // 矩形の十分内側（左上から +2px）は白、十分外側（左上から -2px）は黒。
    expect(at(Math.ceil(rect.x) + 2, Math.ceil(rect.y) + 2)).toMatchObject({
      r: 255,
      g: 255,
      b: 255,
    })
    expect(at(Math.floor(rect.x) - 2, Math.floor(rect.y) - 2)).toMatchObject({
      r: 0,
      g: 0,
      b: 0,
    })
  })
})
