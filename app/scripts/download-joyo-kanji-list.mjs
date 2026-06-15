import { writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const SOURCE_URL =
  'https://blog.frost.kiwi/joyo-kanji-unicode/joyo-kanji-unicode-pyftsubset.txt'
const OUT_PATH = resolve(__dirname, 'joyo-kanji-unicodes.txt')

async function main() {
  if (existsSync(OUT_PATH)) {
    console.log(`既に存在: ${OUT_PATH}`)
    return
  }
  console.log(`取得: ${SOURCE_URL}`)
  const res = await fetch(SOURCE_URL)
  if (!res.ok) throw new Error(`Download failed: ${res.status}`)
  const text = await res.text()
  writeFileSync(OUT_PATH, text, 'utf-8')
  const lines = text.split('\n').filter(l => l.trim().length > 0)
  console.log(`保存完了: ${OUT_PATH}`)
  console.log(`  ${lines.length} 行`)
  console.log(`  先頭 3 行: ${lines.slice(0, 3).join(' / ')}`)
  console.log(`  末尾 3 行: ${lines.slice(-3).join(' / ')}`)
}
main().catch(err => { console.error(err); process.exit(1) })
