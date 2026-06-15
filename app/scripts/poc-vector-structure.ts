/**
 * N-6 Step0 PoC: pdf.js getOperatorList でベクター構造が取れるか検証する。
 *
 * 目的（白塗りロジック転換の事前検証、2026-05-29）:
 *   白塗り対象判定を「OCR 文字座標」から「pdf.js ベクター構造直読」に転換できるか調べる。
 *   矩形 / 塗り色 / 罫線 / CTM 変換後座標が数学的に取れれば、ラベルセルと記入セルを
 *   構造判別できる見込み。取れなければ（= スキャン画像 PDF なら）OCR 経路継続。
 *
 * 検証内容:
 *   - ベクター PDF か画像 PDF か（rect / 描画命令が取れるか、画像命令だけか）
 *   - 矩形命令（constructPath 内の rectangle）の個数
 *   - 塗り色（setFillRGBColor / setFillGray）の取得
 *   - 罫線（stroke / moho 系）の取得
 *   - CTM 変換後の px 座標サンプル
 *
 * 使い方:
 *   pnpm tsx scripts/poc-vector-structure.ts [pdfファイル名]
 *   （デフォルト: sample/IMG_9452.pdf）
 *
 * これは調査 PoC。既存 OCR / scan-extractor は触らない（別レイヤー）。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appRoot = join(__dirname, '..')

const argFile = process.argv[2] ?? 'sample/IMG_9452.pdf'
const pdfPath = join(appRoot, argFile)

async function main() {
  console.log('[poc-vector-structure] starting...')
  console.log(`  target: ${pdfPath}`)

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const { getDocument, OPS } = pdfjs

  // OPS は数値 enum。逆引きで命令名を出せるようにする。
  const opName: Record<number, string> = {}
  for (const [name, code] of Object.entries(OPS)) {
    opName[code as number] = name
  }

  const buf = new Uint8Array(readFileSync(pdfPath))
  console.log(`  size: ${buf.byteLength} bytes`)

  const doc = await getDocument({
    data: buf,
    useSystemFonts: true,
    disableFontFace: true,
  }).promise
  console.log(`  numPages: ${doc.numPages}`)

  // 1 ページ目だけ詳しく見る
  const page = await doc.getPage(1)
  const viewport = page.getViewport({ scale: 2.0 })
  console.log(
    `  page1 viewport(scale=2.0): ${Math.round(viewport.width)} x ${Math.round(viewport.height)} px`,
  )

  const opList = await page.getOperatorList()
  console.log(`  page1 operator count: ${opList.fnArray.length}`)

  // 命令種別ごとに集計
  const counts: Record<string, number> = {}
  for (const fn of opList.fnArray) {
    const name = opName[fn] ?? `unknown(${fn})`
    counts[name] = (counts[name] ?? 0) + 1
  }
  console.log('\n  --- operator histogram (top 25) ---')
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
  for (const [name, n] of sorted.slice(0, 25)) {
    console.log(`    ${name}: ${n}`)
  }

  // ベクター判定のキー命令
  const has = (n: string) => (counts[n] ?? 0) > 0
  const rectCount = counts['rectangle'] ?? 0
  const constructPath = counts['constructPath'] ?? 0
  const fillRGB = counts['setFillRGBColor'] ?? 0
  const fillGray = counts['setFillGray'] ?? 0
  const strokeCount = (counts['stroke'] ?? 0) + (counts['eoStroke'] ?? 0)
  const fillVariants =
    (counts['fill'] ?? 0) + (counts['eoFill'] ?? 0) + (counts['eoFillStroke'] ?? 0) +
    (counts['fillStroke'] ?? 0)
  const imageCount =
    (counts['paintImageXObject'] ?? 0) +
    (counts['paintJpegXObject'] ?? 0) +
    (counts['paintInlineImageXObject'] ?? 0) +
    (counts['paintImageMaskXObject'] ?? 0)
  const textCount = (counts['showText'] ?? 0) + (counts['showSpacedText'] ?? 0)

  console.log('\n  --- vector structure summary ---')
  console.log(`    constructPath: ${constructPath}`)
  console.log(`    rectangle (path内矩形): ${rectCount}`)
  console.log(`    setFillRGBColor: ${fillRGB}  setFillGray: ${fillGray}`)
  console.log(`    fill系(fill/eoFill/...): ${fillVariants}`)
  console.log(`    stroke系(罫線): ${strokeCount}`)
  console.log(`    image系(描画画像): ${imageCount}`)
  console.log(`    text系(showText): ${textCount}`)

  // constructPath の中身を見て rectangle 座標サンプルを取る。
  // OPS.constructPath の args は [opsArray, argsArray, minMax] 形式（pdf.js v4）。
  // opsArray の中に OPS.rectangle が入っており、対応する argsArray から x,y,w,h を拾う。
  console.log('\n  --- constructPath 内の rectangle 座標サンプル（最大5件） ---')
  let sampleShown = 0
  for (let i = 0; i < opList.fnArray.length && sampleShown < 5; i++) {
    if (opList.fnArray[i] !== OPS.constructPath) continue
    const args = opList.argsArray[i] as unknown[]
    // args[0] = ops配列(数値), args[1] = 数値座標フラット配列
    const subOps = args[0] as number[]
    const coords = args[1] as number[]
    let ci = 0
    for (let k = 0; k < subOps.length && sampleShown < 5; k++) {
      const sub = subOps[k]
      if (sub === OPS.rectangle) {
        const x = coords[ci]
        const y = coords[ci + 1]
        const w = coords[ci + 2]
        const h = coords[ci + 3]
        console.log(
          `    rect[${sampleShown}] pdf単位: x=${num(x)} y=${num(y)} w=${num(w)} h=${num(h)}`,
        )
        sampleShown++
        ci += 4
      } else {
        // 他のサブ命令の引数消費数は厳密には命令依存。ここでは概算で 2 ずつ進める
        // （rectangle 抽出が主目的なので近似で十分。本実装では厳密パース）。
        ci += 2
      }
    }
  }
  if (sampleShown === 0) {
    console.log('    （rectangle 命令は constructPath 内に見つからず）')
  }

  // 結論
  console.log('\n  ===== 判定 =====')
  const isVector = constructPath > 0 || fillVariants > 0 || strokeCount > 0
  const isScanImage = imageCount > 0 && constructPath === 0 && textCount === 0
  if (isScanImage) {
    console.log(
      '  → スキャン画像 PDF の可能性大（描画命令はほぼ image のみ、ベクター矩形/罫線なし）',
    )
  } else if (isVector) {
    console.log('  → ベクター PDF（矩形/塗り/罫線命令が取得できた）')
  } else {
    console.log('  → 判定保留（描画命令が少ない、要追加調査）')
  }
  console.log(
    `  has rect=${has('rectangle')} fill=${fillVariants > 0} stroke=${strokeCount > 0} image=${imageCount > 0} text=${textCount > 0}`,
  )

  await page.cleanup()
  await doc.destroy()
}

function num(v: number): string {
  return typeof v === 'number' ? v.toFixed(1) : String(v)
}

main().catch((e) => {
  console.error('fatal:', e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : e)
  process.exit(1)
})
