/**
 * Noto Sans JP フォントダウンロードスクリプト。
 *
 * Google Fonts CDN から Noto Sans JP Regular の TTF を取得し、
 * `app/assets/fonts/NotoSansJP-Regular.ttf` に保存する。
 *
 * 配布元: Google Fonts（OFL-1.1）
 * 取得 URL は Google Fonts API のレスポンス（CSS）を経由して TTF を特定する。
 *
 * Vercel デプロイ時は Phase 6 で本スクリプトをビルド前 hook として実行する想定。
 * v1 開発では開発者が `pnpm exec tsx scripts/download-noto-sans-jp.ts` を 1 回叩く。
 *
 * 出力先: app/assets/fonts/NotoSansJP-Regular.ttf
 *   - .gitignore で除外（ライセンス再配布責任回避、OFL-1.1 条項遵守）
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

/**
 * 公式 notofonts/noto-cjk リポジトリ（GitHub）から OTF を直接取得する。
 * Google Fonts CSS 経由は subset 化された独自フォーマットになるため使えない（初期検証で判明）。
 *
 * 取得先: https://github.com/notofonts/noto-cjk
 *   Noto Sans JP の OTF（Regular weight）= Sans/OTF/Japanese/NotoSansJP-Regular.otf
 *   約 4.5MB、OFL-1.1
 */
// 公式リポジトリでのファイル名は NotoSansCJKjp-Regular.otf（初期検証時に GitHub API で確認）
const FONT_URL =
  'https://github.com/notofonts/noto-cjk/raw/main/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf'

const OUT_PATH = resolve(__dirname, '../assets/fonts/NotoSansCJKjp-Regular.otf')

async function main(): Promise<void> {
  if (existsSync(OUT_PATH)) {
    console.log(`既に存在: ${OUT_PATH}`)
    return
  }
  mkdirSync(dirname(OUT_PATH), { recursive: true })

  console.log(`OTF 取得: ${FONT_URL}`)
  const fontRes = await fetch(FONT_URL, { redirect: 'follow' })
  if (!fontRes.ok) throw new Error(`Font fetch failed: ${fontRes.status}`)
  const buffer = Buffer.from(await fontRes.arrayBuffer())
  // OTF magic 'OTTO' (4F 54 54 4F) を確認
  if (
    buffer[0] === 0x4f
    && buffer[1] === 0x54
    && buffer[2] === 0x54
    && buffer[3] === 0x4f
  ) {
    console.log('  ✓ OTF magic OK')
  } else {
    console.warn(
      `  ! OTF magic 不一致 (first 4 bytes hex: ${buffer.subarray(0, 4).toString('hex')})`,
    )
  }
  writeFileSync(OUT_PATH, buffer)
  console.log(`保存完了 (${buffer.byteLength} bytes): ${OUT_PATH}`)
}

main().catch(err => {
  console.error('download-noto-sans-jp fatal:', err)
  process.exit(1)
})
