import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createCanvas, loadImage } from '@napi-rs/canvas'

/**
 * bg.png の値テキスト非表示を視覚的に検証する unit test。
 *
 * 観点（「ラベルは見える / ダミー値は見えない」の単純チェック）:
 *   1) bg.png の <td>（値セル）領域内のピクセルがほぼ白（暗ピクセル割合がごく小さい）
 *   2) 同領域を thumb PNG で測ると暗ピクセル割合が明確に高い（値テキストが描かれている）
 *
 * これにより、`visibility: hidden` で値テキストが描画されていないこと（案 #2 の核心）
 * を構造的に保証する。ピクセル基準なので OCR 不要・将来のフォント変更にも頑健。
 *
 * 範囲: 罫線そのものは <td> の border として描かれており、内側 1px シュリンクで
 *   罫線ピクセルを除外して内部だけ測る。
 */

const ROOT = join(process.cwd(), 'public', 'builtin-templates')

const CASES = [
  { slug: 'family-meeting', sample: 'discussion' },
  { slug: 'child-schedule', sample: 'discussion' },
  { slug: 'budget-report', sample: 'discussion' },
] as const

type BboxJson = {
  page: { width: number; height: number }
  fields: Record<string, { x: number; y: number; width: number; height: number }>
}

async function loadBbox(slug: string): Promise<BboxJson> {
  const text = await readFile(join(ROOT, `${slug}.bbox.json`), 'utf-8')
  return JSON.parse(text) as BboxJson
}

/**
 * 指定 PNG の指定矩形（CSS px 系・bbox.json と同じ）内部の暗ピクセル割合を返す。
 * - PNG は deviceScaleFactor=2 で撮影されているので px 系 → 物理 px は ×2 換算する。
 * - 罫線除外のため内側 2 物理 px シュリンク。
 * - 「暗」判定は RGB 平均が 200 未満（白背景 #fff = 255、テキスト #1F2937 ≒ 33）。
 */
async function darkPixelRatio(
  pngPath: string,
  rect: { x: number; y: number; width: number; height: number },
  pagePxWidth: number,
  pagePxHeight: number,
): Promise<number> {
  const buf = await readFile(pngPath)
  const img = await loadImage(buf)
  // PNG の物理サイズ。deviceScaleFactor=2 想定。
  const scaleX = img.width / pagePxWidth
  const scaleY = img.height / pagePxHeight
  const shrink = 2 // 罫線除外
  const px0 = Math.round(rect.x * scaleX) + shrink
  const py0 = Math.round(rect.y * scaleY) + shrink
  const px1 = Math.round((rect.x + rect.width) * scaleX) - shrink
  const py1 = Math.round((rect.y + rect.height) * scaleY) - shrink
  const w = Math.max(1, px1 - px0)
  const h = Math.max(1, py1 - py0)

  const canvas = createCanvas(img.width, img.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)
  const data = ctx.getImageData(px0, py0, w, h).data
  let dark = 0
  const total = w * h
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    if ((r + g + b) / 3 < 200) dark++
  }
  return dark / total
}

describe('builtin bg.png value-cell visibility:hidden', () => {
  for (const { slug, sample } of CASES) {
    it(`${slug}: bg.png の値セル領域はほぼ白・thumb は暗ピクセルが明確に多い`, async () => {
      const bbox = await loadBbox(slug)
      const rect = bbox.fields[sample]
      expect(rect, `field=${sample}`).toBeTruthy()
      const bgRatio = await darkPixelRatio(
        join(ROOT, `${slug}.bg.png`),
        rect,
        bbox.page.width,
        bbox.page.height,
      )
      const thumbRatio = await darkPixelRatio(
        join(ROOT, `${slug}.png`),
        rect,
        bbox.page.width,
        bbox.page.height,
      )
      // bg は値テキストが visibility:hidden なのでほぼ白（暗ピクセル<1%）。
      expect(bgRatio, `bg ratio slug=${slug}`).toBeLessThan(0.01)
      // thumb は値テキストが描かれているので暗ピクセル明確（>=2% 想定）。
      expect(thumbRatio, `thumb ratio slug=${slug}`).toBeGreaterThan(0.02)
      // 差が 10 倍以上ある（値テキスト描画の有無が支配的要因）。
      expect(thumbRatio / Math.max(bgRatio, 1e-6)).toBeGreaterThan(10)
    })
  }
})
