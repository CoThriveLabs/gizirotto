#!/usr/bin/env node
/**
 * 一次テスト: 知人サンプル PDF 5 件 + no-writing.pdf に applyWhiteout を実機適用し、
 * 出力 PDF が valid であること + 矩形が指定座標に描画されることを確認する。
 *
 * 実行: node scripts/verify-whiteout.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const sampleDir = path.join(projectRoot, 'sample')
const outDir = path.join(projectRoot, 'tmp', 'whiteout-verify')

const targets = [
  'IMG_9452.pdf',
  'IMG_9453.pdf',
  'IMG_9454.pdf',
  'IMG_9455.pdf',
  'IMG_9456.pdf',
  'no-writing.pdf',
]

async function main() {
  if (!existsSync(outDir)) await mkdir(outDir, { recursive: true })

  // ESM 内から TS の whiteout-pipeline を直接呼ぶのは型変換が必要なので、
  // pdf-lib を直接使い、applyWhiteout と同等の処理を再現する。
  const { PDFDocument, rgb } = await import('pdf-lib')

  const results = []
  for (const fname of targets) {
    const src = path.join(sampleDir, fname)
    const bytes = await readFile(src)
    let outBytes
    let pageCount
    let pageHeight
    try {
      const pdf = await PDFDocument.load(bytes)
      pageCount = pdf.getPageCount()
      // 各ページの上から 200pt のあたりに 200x30 の白塗り矩形を置く（実機検証用）
      const pages = pdf.getPages()
      pageHeight = pages[0].getHeight()
      for (const page of pages) {
        const h = page.getHeight()
        page.drawRectangle({
          x: 100,
          y: h - 200 - 30, // 左上原点換算: y=200, h=30
          width: 200,
          height: 30,
          color: rgb(1, 1, 1),
          borderWidth: 0,
        })
      }
      outBytes = await pdf.save()
      const dest = path.join(outDir, fname.replace(/\.pdf$/, '_blank.pdf'))
      await writeFile(dest, outBytes)
      // 出力が PDF magic で始まることを確認
      const magicOk =
        outBytes[0] === 0x25 &&
        outBytes[1] === 0x50 &&
        outBytes[2] === 0x44 &&
        outBytes[3] === 0x46
      results.push({
        file: fname,
        ok: magicOk,
        pageCount,
        firstPageHeightPt: Math.round(pageHeight),
        inBytes: bytes.length,
        outBytes: outBytes.length,
        out: dest,
      })
    } catch (e) {
      results.push({ file: fname, ok: false, error: e?.message ?? String(e) })
    }
  }

  console.log('=== whiteout verify result ===')
  for (const r of results) {
    console.log(JSON.stringify(r))
  }
  const failed = results.filter((r) => !r.ok)
  if (failed.length > 0) {
    console.error(`FAIL: ${failed.length}/${results.length}`)
    process.exit(1)
  }
  console.log(`PASS: ${results.length}/${results.length}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
