/**
 * 動的プレビュー用フォントローダ。
 *
 * AdjustView のクライアント Canvas2D 動的プレビューが、最終出力 PDF（pdf-lib 経由）と
 * **glyph advance width を完全一致** させるための薄いラッパ。opentype.js を **動的 import** で
 * ロードし、Noto Sans JP（subset OTF）をブラウザ fetch → `FittableFont` 互換オブジェクトを返す。
 *
 * これにより `fitting.ts` の `wrapText` / `lineExtent` / `fitMultiline` を canvas 側からも
 * **同じメトリクスソース（OTF テーブル）で呼べる** ようになり、プレビューと PDF で wrap 位置・
 * フォントサイズ・改行行数が構造的に一致する（v2.2 §1-2-6-3 「fitMultiline 同型化」）。
 *
 * 🚨 サーバ専用 import 分離（§3-5・mistake.md 2026-06-06 致命傷の教訓）:
 *   - 本ファイルは **ブラウザ専用 pure**。`@napi-rs/canvas` / `pdf-lib` / `fontkit` / `sharp` /
 *     `node:fs` / `node:path` を一切 import しない。
 *   - opentype.js は ESM ピュア JS（ネイティブ依存なし）でブラウザでもサーバでも動くが、
 *     本ファイルの想定呼出は AdjustView（クライアント）からの **dynamic import 経由のみ**。
 *   - First Load JS への影響を避けるため、AdjustView 側で `await import('./preview-font-loader')`
 *     する遅延ロード前提。
 *
 * フォールバック方針（§1-2-6-2 推しの根拠 4）:
 *   - opentype.js ロード失敗 / OTF fetch 失敗 / parse 失敗のいずれでも例外を投げず `null` を返す。
 *   - 呼出側（AdjustView / compositeFieldValuesOnCanvas）は `null` 受領時に
 *     v2.1 の `ctx.measureText` 経路に **サイレント fallback**（劣化プレビュー）。
 *   - これによりフォントロード遅延中・ネットワーク不調時でも UI が止まらない。
 */
import type { FittableFont } from '@/lib/pdf-output/fitting'

/**
 * subset 済 Noto Sans JP OTF（JIS 第 1+2 水準 + 記号）のクライアント配信パス。
 *
 * - 元は `assets/fonts/NotoSansCJKjp-Regular-subset.otf`（サーバ pdf-lib 経由・約 1.4 MB）。
 * - 段階 2-D3 で `public/fonts/` 直下にコピー（Vercel public/ 静的配信・CDN キャッシュ可）。
 * - サブセット範囲は pdf-lib 側と同一の OTF を使うため、pdf-lib `widthOfTextAtSize` と
 *   `opentype.js getAdvanceWidth` のメトリクスが構造的に一致する。
 */
const PREVIEW_FONT_URL = '/fonts/NotoSansJP-Regular.subset.otf'

/**
 * `fitting.ts` の `FittableFont` 構造的部分型を実装する OTF ベース実装。
 * 公開 API は `widthOfTextAtSize(text, size)` と `heightAtSize(size)` の 2 つだけ。
 */
export interface PreviewFont extends FittableFont {
  /** opentype.js の Font 実体（テストで参照したいときのみ使う）。通常使わない。 */
  readonly _font: unknown
}

/**
 * モジュール内シングルトン。同一セッション内で複数回 `loadPreviewFont` が呼ばれても
 * fetch は 1 回だけになる（同時並行呼出に対しても Promise 共有で 1 回に集約）。
 */
let cachedPromise: Promise<PreviewFont | null> | null = null

/**
 * opentype.js を遅延 import + OTF を fetch → FittableFont 互換オブジェクトを返す。
 *
 * 失敗時は `null`（呼出側で fallback）。例外は throw しない。
 *
 * @returns FittableFont 互換 or null（fallback シグナル）。
 */
export function loadPreviewFont(): Promise<PreviewFont | null> {
  if (cachedPromise) return cachedPromise
  cachedPromise = loadInternal().catch(() => null)
  return cachedPromise
}

/**
 * テスト用: 内部キャッシュをリセットする。本番コードからは呼ばないこと。
 * （`tests/unit/preview-font-loader.test.ts` でロード分岐を独立に検証するために用意）。
 */
export function _resetPreviewFontCache(): void {
  cachedPromise = null
}

async function loadInternal(): Promise<PreviewFont | null> {
  // 🚨 SSR 時は document/fetch が無いケースもある。早期 null で fallback。
  if (typeof window === 'undefined' || typeof fetch === 'undefined') return null

  // 動的 import で opentype.js を取得（First Load JS に乗らない）。
  let opentype: typeof import('opentype.js')
  try {
    opentype = await import('opentype.js')
  } catch {
    return null
  }

  // OTF を fetch（CDN cache 効くので 2 回目以降は instant）。
  let buf: ArrayBuffer
  try {
    const res = await fetch(PREVIEW_FONT_URL, { cache: 'force-cache' })
    if (!res.ok) return null
    buf = await res.arrayBuffer()
  } catch {
    return null
  }

  // opentype.js parse（同期）。例外は catch して null。
  let font: import('opentype.js').Font
  try {
    font = opentype.parse(buf)
  } catch {
    return null
  }

  return makeFittable(font)
}

/**
 * opentype.js Font を `FittableFont` 互換オブジェクトに薄くラップする。
 *
 * - `widthOfTextAtSize(text, size)` = `font.getAdvanceWidth(text, size)`
 *   pdf-lib も内部で同じ OTF テーブル（fontkit 経由）の advance width を読むため、
 *   両者のメトリクスは構造的に一致する（小数誤差は描画影響なし）。
 * - `heightAtSize(size)` = ascent + descent から pt 高さを返す（pdf-lib `heightAtSize` と同型）。
 *   ただし記入欄経路の wrap/sizeByHeight は `FIT_HEIGHT_RATIO=1.0` 固定で運用するため
 *   この heightAtSize は実用上ほとんど呼ばれない（uniform-size.ts は係数固定）。
 */
function makeFittable(font: import('opentype.js').Font): PreviewFont {
  const unitsPerEm = font.unitsPerEm || 1000
  // ascent + descent（OS/2 table 由来）を unitsPerEm で正規化（pdf-lib 互換）。
  const ascent = font.ascender ?? unitsPerEm * 0.88
  const descent = Math.abs(font.descender ?? unitsPerEm * 0.12)
  const heightRatio = (ascent + descent) / unitsPerEm

  return {
    widthOfTextAtSize(text: string, size: number): number {
      if (text.length === 0 || size <= 0) return 0
      try {
        return font.getAdvanceWidth(text, size)
      } catch {
        // opentype.js が稀に投げる（未対応 glyph 等）→ 防御で 0 を返す。
        return 0
      }
    },
    heightAtSize(size: number): number {
      return heightRatio * size
    },
    _font: font,
  }
}
