#!/usr/bin/env node
/**
 * H-3 補助: Vercel ビルド後の .next/standalone 配下に Noto Sans CJK JP の
 * subset OTF 実体が含まれているかを確認する。
 *
 * 使い方:
 *   pnpm build && node scripts/verify-font-bundle.mjs
 *
 * 期待:
 *   - .next/standalone/assets/fonts/NotoSansCJKjp-Regular-subset.otf が存在
 *   - サイズが 0 byte でないこと（symlink 切れ等の検出）
 *
 * Vercel 上で実行する想定はなく、ローカルでの bundle 検証用。
 * CI 化は Phase 6 で next.config.mjs 変更時に走らせる想定。
 */
import { statSync, existsSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

const ROOT = resolve(process.cwd())
const CANDIDATES = [
  '.next/standalone/assets/fonts/NotoSansCJKjp-Regular-subset.otf',
  '.next/standalone/app/assets/fonts/NotoSansCJKjp-Regular-subset.otf',
  '.next/server/assets/fonts/NotoSansCJKjp-Regular-subset.otf',
]

let found = false
for (const rel of CANDIDATES) {
  const full = join(ROOT, rel)
  if (existsSync(full)) {
    const size = statSync(full).size
    if (size > 1024) {
      console.log(`[verify-font-bundle] OK: ${rel} (${size} bytes)`)
      found = true
    } else {
      console.error(
        `[verify-font-bundle] FAIL: ${rel} exists but is only ${size} bytes`,
      )
      process.exit(1)
    }
  }
}

if (!found) {
  console.error('[verify-font-bundle] FAIL: subset OTF not found in any expected location')
  console.error('Expected one of:')
  for (const rel of CANDIDATES) console.error(`  - ${rel}`)
  // 参考: .next/standalone がそもそも存在するか
  const standaloneRoot = join(ROOT, '.next/standalone')
  if (existsSync(standaloneRoot)) {
    console.error('\n.next/standalone exists. Top-level entries:')
    for (const e of readdirSync(standaloneRoot)) console.error(`  - ${e}`)
  } else {
    console.error(
      '\n.next/standalone not found. Set `output: "standalone"` in next.config or build first.',
    )
  }
  process.exit(1)
}

process.exit(0)
