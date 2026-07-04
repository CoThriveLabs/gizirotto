import 'server-only'
import * as exifr from 'exifr'
import { PDFDocument } from 'pdf-lib'
import { createCanvas, loadImage } from '@napi-rs/canvas'

const A4_WIDTH_PT = 595.28
const A4_HEIGHT_PT = 841.89
const MARGIN_PT = 36

type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp'

async function webpToPng(bytes: Uint8Array): Promise<Uint8Array> {
  const img = await loadImage(Buffer.from(bytes))
  const canvas = createCanvas(img.width, img.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)
  // canvas.toBuffer returns a Node Buffer; copy into plain Uint8Array for pdf-lib compatibility
  const buf = canvas.toBuffer('image/png')
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

async function applyExifOrientation(
  bytes: Uint8Array,
  mime: ImageMime,
): Promise<{ data: Uint8Array; mime: 'image/jpeg' | 'image/png' }> {
  if (mime === 'image/webp') {
    return { data: await webpToPng(bytes), mime: 'image/png' }
  }
  let orientation: number | undefined
  try {
    const result = await exifr.parse(Buffer.from(bytes), { pick: ['Orientation'] })
    orientation = result?.Orientation
  } catch {
    // EXIF なし = 正立とみなす
  }
  if (!orientation || orientation === 1) {
    return { data: bytes, mime }
  }
  // orientation 2-8: canvas で回転補正 → PNG として返す
  const img = await loadImage(Buffer.from(bytes))
  const w = img.width
  const h = img.height
  // 5,6,7,8 は width/height が入れ替わる
  const swapped = orientation >= 5
  const canvas = createCanvas(swapped ? h : w, swapped ? w : h)
  const ctx = canvas.getContext('2d')
  ctx.save()
  switch (orientation) {
    case 2: ctx.transform(-1, 0, 0, 1, w, 0); break
    case 3: ctx.transform(-1, 0, 0, -1, w, h); break
    case 4: ctx.transform(1, 0, 0, -1, 0, h); break
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break
    case 6: ctx.transform(0, 1, -1, 0, h, 0); break
    case 7: ctx.transform(0, -1, -1, 0, h, w); break
    case 8: ctx.transform(0, -1, 1, 0, 0, w); break
  }
  ctx.drawImage(img, 0, 0)
  ctx.restore()
  // canvas.toBuffer returns a Node Buffer; copy into plain Uint8Array for pdf-lib compatibility
  const buf = canvas.toBuffer('image/png')
  return { data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), mime: 'image/png' }
}

function fitContain(
  imgW: number,
  imgH: number,
  pageW: number,
  pageH: number,
  margin: number,
): { x: number; y: number; width: number; height: number } {
  const maxW = pageW - margin * 2
  const maxH = pageH - margin * 2
  const scale = Math.min(maxW / imgW, maxH / imgH)
  const width = imgW * scale
  const height = imgH * scale
  const x = (pageW - width) / 2
  const y = (pageH - height) / 2
  return { x, y, width, height }
}

export async function imageToA4Pdf(
  imageBytes: Uint8Array,
  mime: ImageMime,
): Promise<Uint8Array> {
  if (imageBytes.length === 0) {
    throw new Error('IMAGE_EMPTY: imageBytes is empty')
  }
  const { data, mime: resolvedMime } = await applyExifOrientation(imageBytes, mime)
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([A4_WIDTH_PT, A4_HEIGHT_PT])
  const img =
    resolvedMime === 'image/png'
      ? await pdf.embedPng(data)
      : await pdf.embedJpg(data)
  const { width: imgW, height: imgH } = img.scale(1)
  const { x, y, width, height } = fitContain(imgW, imgH, A4_WIDTH_PT, A4_HEIGHT_PT, MARGIN_PT)
  page.drawImage(img, { x, y, width, height })
  return pdf.save()
}

export { applyExifOrientation }
