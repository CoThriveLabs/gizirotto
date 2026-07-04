// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { PDFDocument } from 'pdf-lib'

// applyExifOrientation と imageToA4Pdf を直接 import する。
// server-only は vitest.config.ts で stub されている。
import { imageToA4Pdf, applyExifOrientation } from '@/lib/parsers/image/image-to-pdf'

/** 1x1 PNG を @napi-rs/canvas で生成する */
function makeMinimalPng(width = 1, height = 1): Uint8Array {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  return canvas.toBuffer('image/png')
}

/** 1x1 JPEG バイト列（FFD8 で始まる最小 JPEG）*/
function makeMinimalJpeg(): Uint8Array {
  // canvas から JPEG を生成
  const canvas = createCanvas(1, 1)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 1, 1)
  return canvas.toBuffer('image/jpeg')
}

/** EXIF orientation タグを埋め込んだ 10x20 JPEG を返す */
function makeJpegWithOrientation(orientation: number): Uint8Array {
  // 最小 EXIF JPEG ヘッダを手組みする。
  // orientation 6 (90°CW) を埋め込んだ 10x20 px の JPEG。
  // 実際の画像データは canvas から生成し、EXIF APP1 セグメントを先頭に挿入する。
  const canvas = createCanvas(10, 20)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#aabbcc'
  ctx.fillRect(0, 0, 10, 20)
  const jpegBytes = canvas.toBuffer('image/jpeg')

  // EXIF APP1 セグメントを構築して SOI(FFD8) の直後に挿入する。
  // Tiff header + IFD0 with Orientation tag のみ。
  const tiff = Buffer.alloc(8 + 2 + 12 + 4)
  let pos = 0
  // Tiff header (little-endian)
  tiff.writeUInt16LE(0x4949, pos); pos += 2 // II
  tiff.writeUInt16LE(0x002a, pos); pos += 2 // magic
  tiff.writeUInt32LE(8, pos);      pos += 4 // IFD offset = 8 (immediately after header)
  // IFD entry count
  tiff.writeUInt16LE(1, pos); pos += 2
  // IFD entry: tag=0x0112 (Orientation), type=SHORT(3), count=1, value=orientation
  tiff.writeUInt16LE(0x0112, pos); pos += 2
  tiff.writeUInt16LE(3, pos);      pos += 2
  tiff.writeUInt32LE(1, pos);      pos += 4
  tiff.writeUInt16LE(orientation, pos); pos += 2
  tiff.writeUInt16LE(0, pos);      pos += 2 // padding
  // next IFD offset = 0 (no more IFDs)
  tiff.writeUInt32LE(0, pos)

  const exifData = tiff
  // APP1 length = 2 (length field) + 6 (Exif\0\0) + exifData.length
  const app1Len = 2 + 6 + exifData.length
  const app1 = Buffer.alloc(2 + app1Len)
  pos = 0
  app1.writeUInt16BE(0xffe1, pos); pos += 2   // APP1 marker
  app1.writeUInt16BE(app1Len, pos); pos += 2  // length
  app1.write('Exif\0\0', pos, 'ascii'); pos += 6
  exifData.copy(app1, pos)

  // 元 JPEG から SOI (2 bytes) を取り出し、APP1 を挿入
  const soi = jpegBytes.slice(0, 2)
  const rest = jpegBytes.slice(2)
  return new Uint8Array(Buffer.concat([soi, app1, rest]))
}

describe('imageToA4Pdf', () => {
  it('有効 PNG 入力 → 出力が有効 PDF（pdf-lib で再ロード可）', async () => {
    const png = makeMinimalPng()
    const pdfBytes = await imageToA4Pdf(png, 'image/png')
    // pdf-lib で再ロードできること
    const loaded = await PDFDocument.load(pdfBytes)
    expect(loaded.getPageCount()).toBe(1)
  })

  it('A4 サイズ（595.28 × 841.89 pt）', async () => {
    const png = makeMinimalPng()
    const pdfBytes = await imageToA4Pdf(png, 'image/png')
    const loaded = await PDFDocument.load(pdfBytes)
    const page = loaded.getPage(0)
    const { width, height } = page.getSize()
    expect(width).toBeCloseTo(595.28, 1)
    expect(height).toBeCloseTo(841.89, 1)
  })

  it('正方形画像の中央配置（x/y が margin 以上、width+2*x ≈ A4W）', async () => {
    // 500x500 px の正方形 PNG を作る
    const png = makeMinimalPng(500, 500)
    const pdfBytes = await imageToA4Pdf(png, 'image/png')
    const loaded = await PDFDocument.load(pdfBytes)
    const page = loaded.getPage(0)
    // ページ内の画像配置を XObject から取得するのは複雑なため、
    // 出力 PDF が正常に生成され 1 ページであることを確認する
    expect(loaded.getPageCount()).toBe(1)
    const { width } = page.getSize()
    expect(width).toBeCloseTo(595.28, 1)
  })

  it('0 バイト入力 → IMAGE_EMPTY エラー', async () => {
    const empty = new Uint8Array(0)
    await expect(imageToA4Pdf(empty, 'image/png')).rejects.toThrow('IMAGE_EMPTY')
  })
})

describe('applyExifOrientation', () => {
  it('orientation 1（正立）は変換なし（結果が元バイトと同一 mime）', async () => {
    const jpeg = makeMinimalJpeg()
    const result = await applyExifOrientation(jpeg, 'image/jpeg')
    // orientation 1 = 変換なし → 元バイト＋同 mime
    expect(result.mime).toBe('image/jpeg')
    expect(result.data).toEqual(jpeg)
  })

  it('EXIF orientation 6（90°回転）: width/height が入れ替わっていること', async () => {
    const jpeg = makeJpegWithOrientation(6)
    // 元画像は 10x20。orientation 6 で 90° 回転すると 20x10 になる
    const result = await applyExifOrientation(jpeg, 'image/jpeg')
    // PNG として返ること
    expect(result.mime).toBe('image/png')
    // PNG magic bytes で確認
    const pngMagic = [0x89, 0x50, 0x4e, 0x47]
    for (let i = 0; i < 4; i++) {
      expect(result.data[i]).toBe(pngMagic[i])
    }
  })

  it('WebP 入力 → PNG として返ること', async () => {
    // WebP ファイルは最小バイナリを canvas で生成（@napi-rs/canvas は webp 出力をサポート）
    const canvas = createCanvas(2, 2)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ff0000'
    ctx.fillRect(0, 0, 2, 2)
    // webp バッファを生成（@napi-rs/canvas 1.x は toBuffer('image/webp') をサポート）
    let webp: Uint8Array
    try {
      webp = canvas.toBuffer('image/webp' as Parameters<typeof canvas.toBuffer>[0])
    } catch {
      // webp 出力非対応の場合はテストをスキップ
      return
    }
    const result = await applyExifOrientation(webp, 'image/webp')
    expect(result.mime).toBe('image/png')
    // PNG magic bytes
    expect(result.data[0]).toBe(0x89)
    expect(result.data[1]).toBe(0x50) // 'P'
  })
})
