/**
 * Noto Sans CJK JP フォントローダー（Phase 2.5 Week 5、案 c 適用済）。
 *
 * pdf-lib + @pdf-lib/fontkit で OTF を embedFont する共通ローダー。
 * SimplePdfGenerator / PdfOverlayGenerator の両方で利用される。
 *
 * フォントファイル（優先順）:
 *   1. `assets/fonts/NotoSansCJKjp-Regular-subset.otf`（約 1.4 MB、案 c subset 版）
 *      - pyftsubset で常用漢字 2136 + 主要記号に絞り込み済
 *      - 開発者は `pnpm download-font && pnpm exec node scripts/download-joyo-kanji-list.mjs
 *        && pnpm exec node scripts/subset-noto-sans-jp.mjs` で生成
 *      - Vercel デプロイ: subset .otf は git commit 済（N-5 follow-up 2 2026-05-28）
 *   2. `assets/fonts/NotoSansCJKjp-Regular.otf`（約 16 MB、未 subset の原本）
 *      - subset ファイルが無いときのフォールバック（開発時 download-font 直後など）
 *      - 出力 PDF サイズが大きくなる警告ログを出す
 *
 * subset 切替の経緯（Week 4 → Week 5）:
 *   Week 4: pdf-lib + @pdf-lib/fontkit で OTF/CFF の subset=true が
 *           RangeError を起こす挙動を確認 → subset=false 強制で +16MB
 *   採用案: pyftsubset で事前に subset 化した軽量フォントを使い、subset=true / false
 *           いずれでも 1-2MB 程度に収まる構成へ移行
 *
 * 注意（Edge V-2 連動の本格検証）:
 *   - pdf-lib の embedFont は内部で fontkit を呼ぶため、PDFDocument に
 *     registerFontkit(fontkit) を先に呼ぶ必要がある
 *   - subset 版でも CFFSubset の bug を踏む可能性があるため、
 *     embedFont の subset オプションは既定 false（実機検証で OK 確認後切替可）
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const SUBSET_FONT_PATH = resolve(
  process.cwd(),
  'assets/fonts/NotoSansCJKjp-Regular-subset.otf',
)
const FULL_FONT_PATH = resolve(
  process.cwd(),
  'assets/fonts/NotoSansCJKjp-Regular.otf',
)

let _cachedFontBytes: Uint8Array | null = null
let _cachedFontKind: 'subset' | 'full' | null = null

/**
 * Noto Sans CJK JP の OTF バイト列を取得（プロセス全体でキャッシュ）。
 * subset 版を優先、無ければ full 版にフォールバック。
 */
export function loadNotoSansCJKjpBytes(): {
  bytes: Uint8Array
  kind: 'subset' | 'full'
} {
  if (_cachedFontBytes && _cachedFontKind) {
    return { bytes: _cachedFontBytes, kind: _cachedFontKind }
  }
  if (existsSync(SUBSET_FONT_PATH)) {
    const buffer = readFileSync(SUBSET_FONT_PATH)
    _cachedFontBytes = new Uint8Array(buffer)
    _cachedFontKind = 'subset'
  } else if (existsSync(FULL_FONT_PATH)) {
    // eslint-disable-next-line no-console
    console.warn(
      '[font-loader] subset 版が見つからないため full 版 (16MB) を使用します。'
        + ' Phase 2.5 Week 5 案 c 推奨: `pnpm exec node scripts/subset-noto-sans-jp.mjs`',
    )
    const buffer = readFileSync(FULL_FONT_PATH)
    _cachedFontBytes = new Uint8Array(buffer)
    _cachedFontKind = 'full'
  } else {
    throw new Error(
      `Noto Sans CJK JP フォントが見つかりません。`
        + ` 期待パス: ${SUBSET_FONT_PATH} or ${FULL_FONT_PATH}.`
        + ` 解決: pnpm download-font && pnpm exec node scripts/download-joyo-kanji-list.mjs`
        + ` && pnpm exec node scripts/subset-noto-sans-jp.mjs`,
    )
  }
  return { bytes: _cachedFontBytes, kind: _cachedFontKind }
}

/**
 * 与えられた PDFDocument に fontkit を登録し、Noto Sans CJK JP を embedFont する。
 *
 * subset 既定値: **false**（safety、Week 5 案 c の subset 版フォントを使うことで
 * 既に十分小さいため、embedFont 側で subset=true にしなくても出力 PDF は 1-2MB / 件）。
 *
 * 注意: pdf-lib の embedFont は構造的に `PDFDocument.embedFont(bytes, { subset })` を呼ぶ。
 * 本関数は pdf-lib への dynamic import を内部で行い、呼び出し側は型シグネチャだけ意識する。
 */
export async function embedNotoSansCJKjp(
  pdfDocument: unknown,
  options: { subset?: boolean } = {},
): Promise<unknown> {
  const { default: fontkit } = await import('@pdf-lib/fontkit')
  const doc = pdfDocument as {
    registerFontkit(kit: unknown): void
    embedFont(
      bytes: Uint8Array,
      opts?: { subset?: boolean },
    ): Promise<unknown>
  }
  doc.registerFontkit(fontkit)
  const { bytes } = loadNotoSansCJKjpBytes()
  return await doc.embedFont(bytes, { subset: options.subset ?? false })
}
