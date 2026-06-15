import 'server-only'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * builtin テンプレ初期 bbox JSON ローダ。
 *
 * 役割:
 *   public/builtin-templates/{slug}.bbox.json を読み、`fields` セクションを
 *   AdjustView の bbox_overrides 互換形式（`{x, y, w, h}`）に変換して返す。
 *
 * server-only:
 *   fs アクセスを含むためクライアントから import 不可。`createMinute`
 *   （Server Action）からのみ呼ぶ前提。
 *
 * fallback ポリシー:
 *   - 不正 slug / ファイル不在 / JSON parse 失敗 / 形式不正 → null を返す（throw しない）。
 *   - 呼出側は null 時に bbox_overrides を {} のままにし、白紙 A4 fallback に委ねる。
 */

/**
 * 対象 3 件の slug を許可リスト化する。他 slug が来た場合は null を返す
 * （誤ったテンプレへの適用防止）。
 */
const BUILTIN_BBOX_SLUGS = ['family-meeting', 'child-schedule', 'budget-report'] as const
export type BuiltinBboxSlug = (typeof BUILTIN_BBOX_SLUGS)[number]

export function isBuiltinBboxSlug(s: string): s is BuiltinBboxSlug {
  return (BUILTIN_BBOX_SLUGS as readonly string[]).includes(s)
}

/**
 * processed_path（例: `builtin/family_meeting_processed.docx`）から bbox JSON の
 * slug を逆引きする。seed.sql / scripts SPECS の対応関係に基づくハードコードマップ。
 */
const PROCESSED_PATH_TO_SLUG: Readonly<Record<string, BuiltinBboxSlug>> = {
  'builtin/family_meeting_processed.docx': 'family-meeting',
  'builtin/child_schedule_processed.docx': 'child-schedule',
  'builtin/budget_report_processed.docx': 'budget-report',
}

export function resolveBuiltinBboxSlugFromProcessedPath(
  processedPath: string | null | undefined,
): BuiltinBboxSlug | null {
  if (!processedPath) return null
  return PROCESSED_PATH_TO_SLUG[processedPath] ?? null
}

/** AdjustView の FieldOverride と同形（x/y/w/h を持つ部分上書き構造）。 */
export type BuiltinBboxEntry = { x: number; y: number; w: number; h: number }

/**
 * JSON 内の生 rect（width/height 表記）を bbox_overrides 互換（w/h 表記）に変換する。
 * 数値以外 / 負値 / NaN / Infinity が混じる場合は当該 field を捨てる（partial として無視）。
 */
function rectToEntry(raw: unknown): BuiltinBboxEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const x = r.x
  const y = r.y
  const width = r.width
  const height = r.height
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number'
  ) return null
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  if (!Number.isFinite(width) || width <= 0) return null
  if (!Number.isFinite(height) || height <= 0) return null
  return { x, y, w: width, h: height }
}

/**
 * 生 JSON から fields セクションを取り出し bbox_overrides 形式に変換する純関数。
 * （fs と分離して unit test を容易にする。）
 *
 * - fields キーが無い / object でない → 空オブジェクト
 * - 個別 field の形式不正 → 当該 field を捨てる
 */
export function parseBuiltinBboxJson(raw: unknown): Record<string, BuiltinBboxEntry> {
  if (!raw || typeof raw !== 'object') return {}
  const fields = (raw as { fields?: unknown }).fields
  if (!fields || typeof fields !== 'object') return {}
  const out: Record<string, BuiltinBboxEntry> = {}
  for (const [name, value] of Object.entries(fields as Record<string, unknown>)) {
    if (typeof name !== 'string' || name.length === 0 || name.length > 100) continue
    const entry = rectToEntry(value)
    if (entry) out[name] = entry
  }
  return out
}

/**
 * slug を受けて `public/builtin-templates/{slug}.png`（サムネ PNG）の bytes を返す。
 * AdjustView 背景に表示するため。不正 slug / 読込失敗 → null。
 */
export async function loadBuiltinThumbnailPng(
  slug: string,
): Promise<Uint8Array | null> {
  if (!isBuiltinBboxSlug(slug)) return null
  const filePath = join(process.cwd(), 'public', 'builtin-templates', `${slug}.png`)
  try {
    const buf = await readFile(filePath)
    return new Uint8Array(buf)
  } catch (e) {
    console.warn('[builtin-bbox-loader] png read failed', { slug, error: (e as Error).message })
    return null
  }
}

/**
 * slug を受けて `public/builtin-templates/{slug}.bg.png`（背景用 PNG・テンプレ枠 +
 * 項目ラベルのみで値セル空白）の bytes を返す。AdjustView 背景に使い、ユーザー入力値と
 * ダミー値の二重表示 UX バグを構造的に解消する。
 *
 * サムネ用 PNG（`{slug}.png`・ダミー値入り）は据置（カードプレビューで使用）。
 * 背景 PNG が見つからない場合は `null` を返し、呼出側は白紙 A4 fallback に委ねる。
 */
export async function loadBuiltinBackgroundPng(
  slug: string,
): Promise<Uint8Array | null> {
  if (!isBuiltinBboxSlug(slug)) return null
  const filePath = join(process.cwd(), 'public', 'builtin-templates', `${slug}.bg.png`)
  try {
    const buf = await readFile(filePath)
    return new Uint8Array(buf)
  } catch (e) {
    console.warn('[builtin-bbox-loader] bg png read failed', {
      slug,
      error: (e as Error).message,
    })
    return null
  }
}

/**
 * slug を受けて bbox JSON を読込み、bbox_overrides 互換 dict を返す。
 * 読込失敗 / 形式不正 → null。
 */
export async function loadBuiltinBboxOverrides(
  slug: string,
): Promise<Record<string, BuiltinBboxEntry> | null> {
  if (!isBuiltinBboxSlug(slug)) return null
  const filePath = join(process.cwd(), 'public', 'builtin-templates', `${slug}.bbox.json`)
  let text: string
  try {
    text = await readFile(filePath, 'utf-8')
  } catch (e) {
    console.warn('[builtin-bbox-loader] read failed', { slug, error: (e as Error).message })
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    console.warn('[builtin-bbox-loader] parse failed', { slug, error: (e as Error).message })
    return null
  }
  const overrides = parseBuiltinBboxJson(parsed)
  if (Object.keys(overrides).length === 0) return null
  return overrides
}

/**
 * bbox JSON 生 object から `page.{width,height}` を抽出する pure 関数。
 *
 * bg.png + overlay 合成の sx/sy 変換係数に必要な pt 空間サイズを取り出す。
 * `page.{width,height}` は PDF rasterize 時の pt 単位で書き出した値（A4 縦なら 595×842）。
 *
 * 数値以外 / 負値 / NaN / Infinity が混じったら null を返し、呼出側で従来の bg.png 直返し
 * fallback に委ねる（既存挙動への退避路を残す）。
 */
export function parseBuiltinPagePtSize(
  raw: unknown,
): { width: number; height: number } | null {
  if (!raw || typeof raw !== 'object') return null
  const page = (raw as { page?: unknown }).page
  if (!page || typeof page !== 'object') return null
  const w = (page as { width?: unknown }).width
  const h = (page as { height?: unknown }).height
  if (typeof w !== 'number' || typeof h !== 'number') return null
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null
  if (w <= 0 || h <= 0) return null
  return { width: w, height: h }
}

/**
 * slug を受けて bbox JSON を読込み `page.{width,height}` を返す。
 * 読込 / parse / 形式不正のいずれも null（呼出側は従来の bg.png 直返しに退避）。
 */
export async function loadBuiltinPagePtSize(
  slug: string,
): Promise<{ width: number; height: number } | null> {
  if (!isBuiltinBboxSlug(slug)) return null
  const filePath = join(process.cwd(), 'public', 'builtin-templates', `${slug}.bbox.json`)
  let text: string
  try {
    text = await readFile(filePath, 'utf-8')
  } catch (e) {
    console.warn('[builtin-bbox-loader] pagePtSize read failed', {
      slug,
      error: (e as Error).message,
    })
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    console.warn('[builtin-bbox-loader] pagePtSize parse failed', {
      slug,
      error: (e as Error).message,
    })
    return null
  }
  return parseBuiltinPagePtSize(parsed)
}
