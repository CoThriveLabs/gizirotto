/**
 * field 単位の bbox/fontSize 上書き純関数群（段階 2 D-core・
 * 設計書 minutes_adjust_editor_renewal_design_2026-06-08 §3）。
 *
 * 🚨 クライアント/サーバ共有純関数（§3-5・mistake.md 2026-06-06）:
 *   - サーバ専用 import（@napi-rs/canvas / pdf-lib / sharp / node:fs 等）を一切持たない。
 *   - zod スキーマとフィールド型のみ参照（pdf-field-schema も pure）。
 *   - これによりブラウザバンドルにネイティブ依存を混入させずクライアント AdjustView から
 *     import 可能（mistake.md 2026-06-06 違反パターン回避）。
 *
 * 責務:
 *   - `FieldOverride` 型（§3-2 partial・x/y/w/h/fontSize 全任意）
 *   - `parseFieldOverrides` 緩和（§3-3）: 旧 `{x,y}` のみ override も partial も両方受け入れる
 *   - `applyFieldOverride` 純関数（§3-5）: PdfField 1 件に override を適用（bbox 差替・font.size 差替）
 *   - `applyBboxOverrides`: PdfField[] に上書きを一括適用するサーバ/クライアント共通ヘルパ
 */
import type { PdfField } from '../ai/schemas/pdf-field-schema'

/**
 * §3-2 partial override 型。x/y/w/h/fontSize 全任意。欠損 = テンプレ既定 + 自動統一サイズ。
 *
 * 後方互換: 旧データ `{x, y}` のみ override も partial として有効。w/h/fontSize 欠損時は
 * テンプレ既定の bbox.w/h を保ち、自動統一サイズ（§4 computeUniformFontSize）が適用される。
 */
export type FieldOverride = {
  x?: number
  y?: number
  w?: number
  h?: number
  /** per-field 手動サイズ上書き（pt）。欠損 = §4 自動統一サイズ。§2-4 大きさ ± で操作。 */
  fontSize?: number
}

/** field name → FieldOverride の partial マップ。 */
export type BboxOverrides = Record<string, FieldOverride>

/**
 * raw（DB jsonb / sessionStorage 等）から BboxOverrides を緩く正規化する（§3-3）。
 *
 * - 各値は数値かつ有限のみ採用（NaN / Infinity / 文字列等は欠損扱い）。
 * - x/y も任意化済（旧実装は両方必須でないと無視していた・page.tsx L96 周辺）。
 * - 全フィールド欠損の override（空オブジェクト）は採用せず除外（無意味なノイズ削減）。
 *
 * 後方互換チェック:
 *   - 旧 `{name:{x,y}}` のみ → そのまま採用（w/h/fontSize は undefined）。
 *   - 不正値（数値でない w 等）→ 当該キーだけ欠損扱い（他のキーは生かす）。
 */
export function parseFieldOverrides(raw: unknown): BboxOverrides {
  if (!raw || typeof raw !== 'object') return {}
  const out: BboxOverrides = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue
    const obj = v as Record<string, unknown>
    const override: FieldOverride = {}
    if (isFiniteNumber(obj.x)) override.x = obj.x
    if (isFiniteNumber(obj.y)) override.y = obj.y
    if (isFiniteNumber(obj.w) && obj.w > 0) override.w = obj.w
    if (isFiniteNumber(obj.h) && obj.h > 0) override.h = obj.h
    if (isFiniteNumber(obj.fontSize) && obj.fontSize > 0) {
      override.fontSize = obj.fontSize
    }
    // 全フィールド欠損は採用しない（{} を保存しないノイズ除外）。
    if (
      override.x !== undefined ||
      override.y !== undefined ||
      override.w !== undefined ||
      override.h !== undefined ||
      override.fontSize !== undefined
    ) {
      out[k] = override
    }
  }
  return out
}

/**
 * PdfField 1 件に override を適用した派生 field を返す純関数（§3-5）。
 *
 * - x/y/w/h: override 値があれば bbox を差替（欠損キーはテンプレ既定保持）。
 * - fontSize: override.fontSize があれば `field.font.size` を差替。これにより overlay-generator /
 *   image-renderer が「既定サイズで入れば縮めない」fitTextInBox の挙動で per-field サイズを採用する。
 *   override.fontSize は §4 自動統一サイズ（uniform）より**最優先**（§2-4）。
 *
 * override が undefined / 空オブジェクトなら元 field をそのまま返す（参照同一）。
 */
export function applyFieldOverride(
  field: PdfField,
  override: FieldOverride | undefined,
): PdfField {
  if (!override) return field
  const hasBboxChange =
    override.x !== undefined ||
    override.y !== undefined ||
    override.w !== undefined ||
    override.h !== undefined
  const hasFontChange = override.fontSize !== undefined
  if (!hasBboxChange && !hasFontChange) return field
  const nextBbox = hasBboxChange
    ? {
        ...field.bbox,
        x: override.x ?? field.bbox.x,
        y: override.y ?? field.bbox.y,
        w: override.w ?? field.bbox.w,
        h: override.h ?? field.bbox.h,
      }
    : field.bbox
  const nextFont = hasFontChange
    ? { ...field.font, size: override.fontSize as number }
    : field.font
  return { ...field, bbox: nextBbox, font: nextFont }
}

/**
 * PdfField[] に BboxOverrides を一括適用する（サーバ/クライアント共通）。
 *
 * §3-3 後方互換ルール:
 *   - override に当該 field 無し → そのまま（テンプレ既定）。
 *   - override の x/y/w/h/fontSize が部分欠損 → 欠損キーはテンプレ既定保持。
 *   - 旧 `{x,y}` のみ override → w/h は元のテンプレ既定・fontSize は undefined（uniform 適用対象）。
 *
 * raw（DB jsonb）も受け取れるように内部で parseFieldOverrides を通す（緩和ガード）。
 */
export function applyBboxOverrides(
  fields: PdfField[],
  raw: unknown,
): PdfField[] {
  if (!raw || typeof raw !== 'object') return fields
  const overrides = parseFieldOverrides(raw)
  if (Object.keys(overrides).length === 0) return fields
  return fields.map((f) => applyFieldOverride(f, overrides[f.name]))
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}
