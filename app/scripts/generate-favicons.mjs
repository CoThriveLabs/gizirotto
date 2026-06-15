// Favicon regeneration from base character PNG.
// Outputs:
//   - src/app/icon.png        (512x512 PNG, Next.js App Router favicon)
//   - src/app/apple-icon.png  (180x180 PNG, iOS home screen icon)
//   - public/favicon.ico      (multi-size ICO: 16/32/48, PNG-embedded)
//
// Run: node scripts/generate-favicons.mjs
import { promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const APP_ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const BASE_PNG = path.join(APP_ROOT, 'public', 'gizirottokun.png')

const ICO_SIZES = [16, 32, 48]
const ICON_PNG_SIZE = 512
const APPLE_ICON_SIZE = 180

async function resizePngBuffer(input, size) {
  return sharp(input)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer()
}

// Build a multi-image ICO containing PNG-encoded entries (Vista+ supported).
// ICO layout:
//   ICONDIR     (6 bytes): reserved=0, type=1, count=N
//   ICONDIRENTRY (16 bytes each): width, height, colors, reserved, planes, bpp,
//                                 size_in_bytes, offset_from_start
//   ...image bytes (PNG payloads back to back)
function buildIco(pngBuffers, sizes) {
  if (pngBuffers.length !== sizes.length) throw new Error('size/buffer length mismatch')
  const headerSize = 6 + 16 * pngBuffers.length
  let offset = headerSize
  const out = Buffer.alloc(headerSize)
  out.writeUInt16LE(0, 0) // reserved
  out.writeUInt16LE(1, 2) // type = 1 (icon)
  out.writeUInt16LE(pngBuffers.length, 4)

  for (let i = 0; i < pngBuffers.length; i++) {
    const size = sizes[i]
    const buf = pngBuffers[i]
    const base = 6 + i * 16
    out.writeUInt8(size >= 256 ? 0 : size, base + 0) // width (0 means 256)
    out.writeUInt8(size >= 256 ? 0 : size, base + 1) // height
    out.writeUInt8(0, base + 2) // color palette (0 = no palette)
    out.writeUInt8(0, base + 3) // reserved
    out.writeUInt16LE(1, base + 4) // color planes
    out.writeUInt16LE(32, base + 6) // bits per pixel
    out.writeUInt32LE(buf.length, base + 8) // image size
    out.writeUInt32LE(offset, base + 12) // offset
    offset += buf.length
  }

  return Buffer.concat([out, ...pngBuffers])
}

async function main() {
  const baseBuf = await fs.readFile(BASE_PNG)
  console.log(`Base: ${BASE_PNG} (${baseBuf.length} bytes)`)

  // 1) src/app/icon.png
  const iconPng = await resizePngBuffer(baseBuf, ICON_PNG_SIZE)
  const iconPath = path.join(APP_ROOT, 'src', 'app', 'icon.png')
  await fs.writeFile(iconPath, iconPng)
  console.log(`Wrote ${iconPath} (${ICON_PNG_SIZE}x${ICON_PNG_SIZE}, ${iconPng.length} bytes)`)

  // 2) src/app/apple-icon.png
  const applePng = await resizePngBuffer(baseBuf, APPLE_ICON_SIZE)
  const applePath = path.join(APP_ROOT, 'src', 'app', 'apple-icon.png')
  await fs.writeFile(applePath, applePng)
  console.log(`Wrote ${applePath} (${APPLE_ICON_SIZE}x${APPLE_ICON_SIZE}, ${applePng.length} bytes)`)

  // 3) public/favicon.ico (16/32/48 PNG-embedded)
  const icoPngs = []
  for (const size of ICO_SIZES) {
    icoPngs.push(await resizePngBuffer(baseBuf, size))
  }
  const icoBuf = buildIco(icoPngs, ICO_SIZES)
  const icoPath = path.join(APP_ROOT, 'public', 'favicon.ico')
  await fs.writeFile(icoPath, icoBuf)
  console.log(`Wrote ${icoPath} (sizes ${ICO_SIZES.join('/')}, ${icoBuf.length} bytes)`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
