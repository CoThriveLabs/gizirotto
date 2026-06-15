/**
 * Noto Sans CJK JP の subset 化スクリプト。
 *
 * 16MB の OTF を、日本語常用 3000 字程度に絞った subset OTF（1-2MB 目標）に変換する。
 *
 * 経緯:
 *   pdf-lib + @pdf-lib/fontkit で OTF の CFFSubset.encode が RangeError を起こすため
 *   embedFont で `subset: false` 強制 = 出力 PDF 1 件あたり +16MB の問題が発生。
 *   フォント側で事前に subset を済ませた軽量フォントを embed することで、
 *   出力 PDF サイズを 1-2MB / 件に削減する。
 *
 * Python venv (.venv/) 内の pyftsubset を呼び出して subset 化する。
 *
 * 文字セット（議事録用途で 99% カバー想定）:
 *   - U+0020-007E: ASCII
 *   - U+3000-303F: 日本語句読点
 *   - U+3040-309F: ひらがな
 *   - U+30A0-30FF: カタカナ
 *   - U+4E00-9FFF: CJK 統合漢字
 *   - U+FF00-FFEF: 全角 / 半角形
 *
 * Vercel デプロイ時は Phase 6 で prebuild hook として実行する。
 *
 * 使い方:
 *   pnpm subset-font
 *
 * 入力: app/assets/fonts/NotoSansCJKjp-Regular.otf（16MB、download-font で取得済）
 * 出力: app/assets/fonts/NotoSansCJKjp-Regular-subset.otf（目標 1-2MB）
 */

import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

const INPUT_PATH = resolve(__dirname, '../assets/fonts/NotoSansCJKjp-Regular.otf')
const OUTPUT_PATH = resolve(__dirname, '../assets/fonts/NotoSansCJKjp-Regular-subset.otf')
const PYTHON_BIN = resolve(__dirname, '../.venv/Scripts/python.exe')

// 常用漢字以外の Unicode 範囲（漢字ブロック U+4E00-9FFF は含めない、
// 代わりに JOYO_FILE で常用漢字 2136 字のみ指定する）
const UNICODE_RANGES = [
  '0020-007E', // ASCII
  '00A0-00FF', // Latin-1 補助
  '2000-206F', // 一般句読点
  '2100-214F', // 文字様記号
  '2190-21FF', // 矢印
  '2200-22FF', // 数学演算子
  '2460-24FF', // 囲み英数字
  '25A0-25FF', // 幾何学模様
  '2600-26FF', // その他記号
  '3000-303F', // CJK 記号・句読点
  '3040-309F', // ひらがな
  '30A0-30FF', // カタカナ
  '3100-312F', // 注音字母
  '3200-32FF', // CJK 互換用文字
  '3300-33FF', // CJK 互換用文字（℃ など）
  // '4E00-9FFF' は意図的に除外（→ JOYO_FILE で常用漢字のみに絞る）
  'FF00-FFEF', // 全角 / 半角形
  'FFF0-FFFF', // 特殊文字
]

// 常用漢字 2136 字の Unicode リスト（pyftsubset 用フォーマット）
const JOYO_FILE = resolve(__dirname, 'joyo-kanji-unicodes.txt')

function checkPrerequisites() {
  if (!existsSync(INPUT_PATH)) {
    console.error(`✗ 入力フォントが見つかりません: ${INPUT_PATH}`)
    console.error('  先に `pnpm download-font` を実行してください。')
    process.exit(1)
  }
  if (!existsSync(PYTHON_BIN)) {
    console.error(`✗ Python venv が見つかりません: ${PYTHON_BIN}`)
    console.error('  以下を実行してください:')
    console.error('    cd app && python -m venv .venv')
    console.error('    .venv/Scripts/pip.exe install fonttools brotli')
    process.exit(1)
  }
}

function runPyftsubset() {
  if (!existsSync(JOYO_FILE)) {
    console.error(`✗ 常用漢字リストが見つかりません: ${JOYO_FILE}`)
    console.error('  以下を実行してください:')
    console.error('    pnpm exec node scripts/download-joyo-kanji-list.mjs')
    process.exit(1)
  }
  const args = [
    '-m',
    'fontTools.subset',
    INPUT_PATH,
    `--output-file=${OUTPUT_PATH}`,
    `--unicodes=${UNICODE_RANGES.join(',')}`,
    `--unicodes-file=${JOYO_FILE}`,
    '--layout-features=*',
    '--glyph-names',
    '--no-hinting',
    '--desubroutinize',
    '--name-IDs=*',
  ]

  console.log('=== pyftsubset 実行 ===')
  console.log(`Python: ${PYTHON_BIN}`)
  console.log(`Input:  ${INPUT_PATH}`)
  console.log(`Output: ${OUTPUT_PATH}`)
  console.log(`Unicodes: ${UNICODE_RANGES.length} 範囲 + 常用漢字 ${JOYO_FILE}`)
  console.log('')

  const t0 = Date.now()
  const result = spawnSync(PYTHON_BIN, args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  const elapsed = Date.now() - t0

  if (result.status !== 0) {
    console.error(`✗ pyftsubset 失敗（exit code ${result.status}, ${elapsed}ms）`)
    if (result.error) console.error(result.error)
    process.exit(1)
  }

  if (!existsSync(OUTPUT_PATH)) {
    console.error('✗ 出力ファイルが生成されませんでした')
    process.exit(1)
  }

  const inputSize = statSync(INPUT_PATH).size
  const outputSize = statSync(OUTPUT_PATH).size
  const reduction = ((1 - outputSize / inputSize) * 100).toFixed(1)
  console.log('')
  console.log('=== 結果 ===')
  console.log(`  処理時間: ${elapsed}ms`)
  console.log(`  入力サイズ: ${(inputSize / 1024 / 1024).toFixed(2)} MB`)
  console.log(`  出力サイズ: ${(outputSize / 1024 / 1024).toFixed(2)} MB`)
  console.log(`  削減率: ${reduction}% (${(inputSize / outputSize).toFixed(1)}x 軽量化)`)

  if (outputSize > 3 * 1024 * 1024) {
    console.warn(
      `! 出力サイズが目標 (1-2MB) を超過: ${(outputSize / 1024 / 1024).toFixed(2)} MB`,
    )
    console.warn('  Unicode 範囲を絞るか、fontTools のオプションを再調整してください。')
  }
}

function dirnameCheck() {
  const outDir = dirname(OUTPUT_PATH)
  if (!existsSync(outDir)) {
    console.error(`✗ 出力先ディレクトリが存在しません: ${outDir}`)
    process.exit(1)
  }
}

checkPrerequisites()
dirnameCheck()
runPyftsubset()
