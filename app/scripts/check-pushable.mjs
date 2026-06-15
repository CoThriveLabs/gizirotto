#!/usr/bin/env node
/**
 * check-pushable.mjs
 *
 * push 前最終確認スクリプト。
 *
 * - git init 済 / 未済どちらでも動作する。
 * - 「これから push される予定（= .gitignore 適用後に tracked / staged になる）」
 *   ファイル一覧を列挙し、想定外パターン（.pdf, secret/token/key, sample/, tmp/ 等）が
 *   含まれていないかを検査する。
 *
 * 使い方:
 *   node app/scripts/check-pushable.mjs
 *
 * 終了コード:
 *   0 = 問題なし
 *   1 = 危険なファイルを検出（push 中止推奨）
 */
import { execSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')

/** 危険パターン定義。matched ファイルは要レビュー扱い。 */
const DANGER_PATTERNS = [
  { re: /\.pdf$/i, reason: 'PDF ファイル（知人サンプル混入リスク）' },
  { re: /\.env(\.|$)/, reason: '.env ファイル（シークレット）' },
  { re: /(^|\/)sample\//, reason: 'sample/ 配下（知人 PDF 領域）' },
  { re: /(^|\/)tmp\//, reason: 'tmp/ 配下（検証中間成果物）' },
  { re: /mistral-ocr-response-snapshot\.json$/, reason: 'Mistral OCR 生 response' },
  { re: /tesseract-test-result\.json$/, reason: 'Tesseract 検証結果' },
  { re: /tesseract-sample-.*\.png$/, reason: 'Tesseract サンプル画像' },
  { re: /rasterize-scale-result\.json$/, reason: 'rasterize 結果' },
  { re: /extraction-report.*\.(json|pdf)$/, reason: '構造抽出レポート成果物' },
  { re: /(^|[^a-zA-Z])secret[^a-zA-Z]?/i, reason: 'secret 文字列を含むファイル名' },
  { re: /(^|[^a-zA-Z])token[^a-zA-Z]?/i, reason: 'token 文字列を含むファイル名' },
  { re: /(^|[^a-zA-Z])api[-_]?key/i, reason: 'api_key 文字列を含むファイル名' },
  { re: /\.pem$/, reason: '秘密鍵 (.pem)' },
  { re: /\.key$/, reason: '秘密鍵 (.key)' },
  { re: /id_rsa/, reason: 'SSH 秘密鍵' },
  { re: /assets\/fonts\/.*\.(otf|ttf)$/, reason: 'Noto Sans CJK フォント（再配布リスク）' },
  { re: /joyo-kanji-unicodes\.txt$/, reason: '常用漢字 Unicode リスト（再配布リスク）' },
]

/** 構造的に許可されているもの（誤検出抑制） */
const ALLOWLIST = [
  /(^|\/)\.gitkeep$/,
  /(^|\/)\.gitignore$/,
  /(^|\/)\.env\.example$/,
  /(^|\/)\.env\.local\.example$/,
  /(^|\/)\.env\.[a-zA-Z]+\.example$/,
  /(^|\/)tests\/fixtures\//,
  /check-pushable\.mjs$/, // 自分自身は "secret/token" 命名を含まない
]

function runGit(cmd) {
  try {
    return execSync(`git -C "${REPO_ROOT}" ${cmd}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    return null
  }
}

function isGitRepo() {
  return existsSync(resolve(REPO_ROOT, '.git'))
}

function listFiles() {
  if (isGitRepo()) {
    // tracked + untracked (但し ignored 除外)
    const out = runGit('ls-files --cached --others --exclude-standard')
    if (out == null) {
      console.error('git ls-files failed')
      process.exit(2)
    }
    return out.split('\n').map(s => s.trim()).filter(Boolean)
  } else {
    // git 未 init: git check-ignore のために一時的に init はせず、
    // git が無い前提で find ベース + .gitignore シミュレーションは複雑なので
    // 「git init 後にもう一度実行してください」案内 + 軽量モード（find + ハードコード除外）
    console.warn('[warn] .git が無いため軽量モード。git init 後の再実行を推奨。')
    return findFilesLight()
  }
}

function findFilesLight() {
  // node-only walk（外部依存なし）。よくある重量ディレクトリは除外。
  const HARD_EXCLUDES = [
    'node_modules', '.next', '.vercel', '.venv', 'coverage',
    'playwright-report', 'test-results', 'tmp', '.git',
  ]
  const results = []
  function walk(dir) {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const e of entries) {
      if (HARD_EXCLUDES.includes(e.name)) continue
      const full = resolve(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile()) results.push(relative(REPO_ROOT, full).replace(/\\/g, '/'))
    }
  }
  walk(REPO_ROOT)
  return results
}

function checkDanger(files) {
  const hits = []
  for (const f of files) {
    if (ALLOWLIST.some(re => re.test(f))) continue
    for (const { re, reason } of DANGER_PATTERNS) {
      if (re.test(f)) {
        hits.push({ file: f, reason })
        break
      }
    }
  }
  return hits
}

function summarize(files, hits) {
  console.log('='.repeat(70))
  console.log('check-pushable.mjs — push 前最終確認')
  console.log('='.repeat(70))
  console.log(`repo root          : ${REPO_ROOT}`)
  console.log(`git initialized    : ${isGitRepo()}`)
  console.log(`pushable files     : ${files.length} 件`)
  console.log(`danger detections  : ${hits.length} 件`)
  console.log('-'.repeat(70))

  if (hits.length === 0) {
    console.log('OK: 危険ファイルなし。push 可能と判断します。')
  } else {
    console.log('NG: 以下のファイルが push 候補に含まれています。確認してください。')
    for (const { file, reason } of hits) {
      console.log(`  - ${file}`)
      console.log(`      reason: ${reason}`)
    }
  }
  console.log('='.repeat(70))

  const byTopDir = new Map()
  for (const f of files) {
    const top = f.split('/')[0] || '.'
    byTopDir.set(top, (byTopDir.get(top) || 0) + 1)
  }
  console.log('top-level breakdown:')
  for (const [k, v] of [...byTopDir.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(30)} ${v}`)
  }
  console.log('='.repeat(70))
}

const files = listFiles()
const hits = checkDanger(files)
summarize(files, hits)

if (!isGitRepo()) {
  console.log('[note] git 未 init のため軽量モード（.gitignore 未適用）。')
  console.log('       git init + git add 後に再実行すると .gitignore 適用済の正確な判定が出ます。')
  console.log('       軽量モード結果は参考値、終了コードは 0 を返します。')
  process.exit(0)
}
process.exit(hits.length === 0 ? 0 : 1)
