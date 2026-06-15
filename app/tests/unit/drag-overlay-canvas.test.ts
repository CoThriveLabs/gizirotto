/**
 * drag-overlay-canvas 純関数 unit test。
 *
 * 検証の主眼:
 *   - paintBackgroundSnapshot: スナップを全面に貼る（clearRect → drawImage）。
 *   - paintDraggingField の白塗り矩形座標が **whiteoutBoxToPxRect と一致**する（式ドリフト検知）。
 *   - paintDraggingField が記入値を compositeFieldValuesOnCanvas（items=1）で重ね描きする。
 *   - 背景貼り直し → 白塗り → 記入値 の合成順。
 *   - whiteoutBox 省略時は塗らない（adjust の field variant 既定経路）。
 *
 * 座標一致は whiteout-composite-canvas.test.ts と同じく @napi-rs/canvas の実描画で、
 * fillText 呼びの検証は jsdom mock ctx で行う。
 */
import { describe, it, expect, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import {
  paintBackgroundSnapshot,
  paintDraggingField,
} from '@/lib/preview/drag-overlay-canvas'
import { whiteoutBoxToPxRect } from '@/lib/parsers/pdf/whiteout-coords'
import {
  _resetWrapCache,
  type FieldValueComposite,
} from '@/lib/preview/field-values-composite-canvas'
import type { WhiteoutBox } from '@/lib/parsers/pdf/whiteout-pipeline'
import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'

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

function makeField(overrides: Partial<PdfField> = {}): PdfField {
  return {
    name: 'sample',
    label: 'サンプル',
    type: 'text',
    bbox: { page: 1, x: 100, y: 200, w: 300, h: 24 },
    max_chars: 200,
    font: { family: 'NotoSansJP', size: 11 },
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

/** 単色のオフスクリーン canvas を作る（背景スナップ相当）。 */
function makeSolidSnapshot(
  w: number,
  h: number,
  rgb: { r: number; g: number; b: number },
) {
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`
  ctx.fillRect(0, 0, w, h)
  return canvas
}

describe('paintBackgroundSnapshot', () => {
  it('スナップを全面に貼る（前フレーム残骸を消して全面スナップ色）', () => {
    const pixelWidth = 60
    const pixelHeight = 60
    // 描画先 canvas を別色で塗っておき、貼り直しで上書きされることを確認。
    const target = createCanvas(pixelWidth, pixelHeight)
    const tctx = target.getContext('2d')
    tctx.fillStyle = 'rgb(0, 0, 0)'
    tctx.fillRect(0, 0, pixelWidth, pixelHeight)

    const snap = makeSolidSnapshot(pixelWidth, pixelHeight, { r: 10, g: 20, b: 30 })
    paintBackgroundSnapshot(
      tctx as unknown as CanvasRenderingContext2D,
      snap as unknown as HTMLCanvasElement,
      pixelWidth,
      pixelHeight,
    )
    const d = tctx.getImageData(30, 30, 1, 1).data
    expect({ r: d[0], g: d[1], b: d[2] }).toMatchObject({ r: 10, g: 20, b: 30 })
  })
})

describe('paintDraggingField — 白塗り矩形座標が whiteoutBoxToPxRect と一致', () => {
  it('whiteoutBox の塗り位置/サイズが純関数の矩形境界と一致する（式ドリフト検知）', () => {
    const pixelWidth = 595
    const pixelHeight = 842
    const widthPt = 595
    const heightPt = 842
    // 黒背景スナップの上に、白の whiteoutBox を新位置に塗る。
    const snap = makeSolidSnapshot(pixelWidth, pixelHeight, { r: 0, g: 0, b: 0 })
    const target = createCanvas(pixelWidth, pixelHeight)
    const tctx = target.getContext('2d')

    const wb = box(1, 100.5, 200.25, 80, 60, WHITE)
    const rect = whiteoutBoxToPxRect(wb, pixelWidth, pixelHeight, widthPt, heightPt)

    const movingField: FieldValueComposite = {
      // value 空 → 記入値描画はスキップ（白塗り矩形の座標だけを検証）。
      field: makeField({ bbox: { page: 1, x: 100.5, y: 200.25, w: 80, h: 60 } }),
      value: '',
    }

    paintDraggingField(
      tctx as unknown as CanvasRenderingContext2D,
      snap as unknown as HTMLCanvasElement,
      movingField,
      pixelWidth,
      pixelHeight,
      widthPt,
      heightPt,
      { whiteoutBox: wb },
    )

    // 矩形中心は白。
    const cx = Math.round(rect.x + rect.w / 2)
    const cy = Math.round(rect.y + rect.h / 2)
    const cd = tctx.getImageData(cx, cy, 1, 1).data
    expect({ r: cd[0], g: cd[1], b: cd[2] }).toMatchObject(WHITE)

    // 十分内側は白、十分外側は黒（境界一致）。
    const inn = tctx.getImageData(Math.ceil(rect.x) + 2, Math.ceil(rect.y) + 2, 1, 1)
      .data
    expect({ r: inn[0], g: inn[1], b: inn[2] }).toMatchObject(WHITE)
    const out = tctx.getImageData(Math.floor(rect.x) - 2, Math.floor(rect.y) - 2, 1, 1)
      .data
    expect({ r: out[0], g: out[1], b: out[2] }).toMatchObject({ r: 0, g: 0, b: 0 })
  })

  it('estimatedBgColor の色で塗る（白以外も反映・whiteoutBoxToPxRect の r/g/b 経由）', () => {
    const pixelWidth = 100
    const pixelHeight = 100
    const snap = makeSolidSnapshot(pixelWidth, pixelHeight, { r: 0, g: 0, b: 0 })
    const target = createCanvas(pixelWidth, pixelHeight)
    const tctx = target.getContext('2d')
    const wb = box(1, 10, 10, 30, 30, { r: 12, g: 200, b: 34 })

    paintDraggingField(
      tctx as unknown as CanvasRenderingContext2D,
      snap as unknown as HTMLCanvasElement,
      { field: makeField(), value: '' },
      pixelWidth,
      pixelHeight,
      pixelWidth,
      pixelHeight,
      { whiteoutBox: wb },
    )
    const d = tctx.getImageData(20, 20, 1, 1).data
    expect({ r: d[0], g: d[1], b: d[2] }).toMatchObject({ r: 12, g: 200, b: 34 })
  })

  it('whiteoutBox 省略時は塗らない（背景スナップがそのまま透ける＝field variant 既定）', () => {
    const pixelWidth = 100
    const pixelHeight = 100
    const snap = makeSolidSnapshot(pixelWidth, pixelHeight, { r: 7, g: 8, b: 9 })
    const target = createCanvas(pixelWidth, pixelHeight)
    const tctx = target.getContext('2d')

    paintDraggingField(
      tctx as unknown as CanvasRenderingContext2D,
      snap as unknown as HTMLCanvasElement,
      { field: makeField(), value: '' },
      pixelWidth,
      pixelHeight,
      pixelWidth,
      pixelHeight,
    )
    // 全面スナップ色のまま（白塗りなし）。
    const d = tctx.getImageData(50, 50, 1, 1).data
    expect({ r: d[0], g: d[1], b: d[2] }).toMatchObject({ r: 7, g: 8, b: 9 })
  })
})

describe('paintDraggingField — 記入値の重ね描画（mock ctx で合成順/呼びを検証）', () => {
  function makeMockCtx() {
    const calls: string[] = []
    const ctx = {
      save: vi.fn(() => calls.push('save')),
      restore: vi.fn(() => calls.push('restore')),
      fillText: vi.fn(() => calls.push('fillText')),
      fillRect: vi.fn(() => calls.push('fillRect')),
      clearRect: vi.fn(() => calls.push('clearRect')),
      drawImage: vi.fn(() => calls.push('drawImage')),
      measureText: vi.fn(() => ({ width: 10 })),
      fillStyle: '',
      font: '',
      textBaseline: '',
    }
    // compositeFieldValuesOnCanvas は ctx.canvas.getContext('2d') で同じ ctx を取り直す。
    const canvas = {
      getContext: vi.fn(() => ctx),
      width: 595,
      height: 842,
    } as unknown as HTMLCanvasElement
    ;(ctx as unknown as { canvas: HTMLCanvasElement }).canvas = canvas
    return { ctx, calls }
  }

  it('背景貼り直し → 記入値 fillText の順で重ね描く（value あり）', () => {
    _resetWrapCache()
    const { ctx, calls } = makeMockCtx()
    const snap = { width: 595, height: 842 } as unknown as HTMLCanvasElement

    paintDraggingField(
      ctx as unknown as CanvasRenderingContext2D,
      snap,
      { field: makeField(), value: 'あいう' },
      595,
      842,
      595,
      842,
    )

    // 背景貼り直し（clearRect + drawImage）が先、記入値 fillText が後。
    expect(calls.indexOf('clearRect')).toBeGreaterThanOrEqual(0)
    expect(calls.indexOf('drawImage')).toBeGreaterThan(calls.indexOf('clearRect'))
    expect(ctx.fillText).toHaveBeenCalled()
    expect(calls.indexOf('fillText')).toBeGreaterThan(calls.indexOf('drawImage'))
  })

  it('value 空白のみなら記入値は描かない（背景貼り直しのみ）', () => {
    const { ctx } = makeMockCtx()
    const snap = { width: 595, height: 842 } as unknown as HTMLCanvasElement
    paintDraggingField(
      ctx as unknown as CanvasRenderingContext2D,
      snap,
      { field: makeField(), value: '   ' },
      595,
      842,
      595,
      842,
    )
    expect(ctx.clearRect).toHaveBeenCalled()
    expect(ctx.drawImage).toHaveBeenCalled()
    expect(ctx.fillText).not.toHaveBeenCalled()
  })
})
