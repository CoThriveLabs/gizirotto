/**
 * 段階2-D3 案 D（v2.5 §1-2-6-2）: render-image API の overlayFields 選別ロジック。
 *
 * route.ts から純関数として切出し、3 つの分岐（raw=false 全積み / raw=true 全 skip /
 * raw=true + raw_except_selected で 1 つだけ skip）を unit テスト可能にする。
 *
 * 🚨 サーバ専用 import 禁止: pdf-lib / @napi-rs/canvas / node:fs を一切持たない pure。
 * route.ts（サーバ）からも将来 AdjustView 系 unit テスト（モック）からも参照可能。
 */

import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'

export interface OverlayFieldEntry<F = PdfField> {
  field: F
  value: string
}

/**
 * overlayFields 選別純関数。
 *
 * @param fields effective fields（applyBboxOverrides 適用後）
 * @param values content_json から flatten した値マップ
 * @param raw raw モードフラグ（true = 記入値スキップ）
 * @param rawExceptSelected raw=true 時のみ作用。指定 field name 1 つだけスキップ（=selected）
 * @returns overlayFields 配列（route.ts の MinuteOverlayField 互換）
 *
 * 挙動マトリクス:
 *   - raw=false                                  → 全 field 積む（既存）
 *   - raw=true,  rawExceptSelected=undefined     → 全 field skip（既存）
 *   - raw=true,  rawExceptSelected='memo'        → memo のみ skip・他は積む（v2.5 新規）
 */
export function buildOverlayFieldsForRender<F extends { name: string }>(
  fields: F[],
  values: Record<string, unknown>,
  raw: boolean,
  rawExceptSelected: string | undefined,
): OverlayFieldEntry<F>[] {
  const out: OverlayFieldEntry<F>[] = []
  // raw=true かつ rawExceptSelected 未指定 = 全 skip。loop 自体に入らない。
  if (raw && rawExceptSelected === undefined) {
    return out
  }
  for (const f of fields) {
    // 案 D: raw=true + rawExceptSelected 指定時は当該 field 1 つだけ skip。
    if (raw && rawExceptSelected !== undefined && f.name === rawExceptSelected) {
      continue
    }
    const v = values[f.name]
    if (v === undefined || v === null) continue
    const text = String(v)
    if (text.length === 0) continue
    out.push({ field: f, value: text })
  }
  return out
}

/**
 * 段階2-D3 案 D: image_cache キャッシュキーの接尾辞生成。
 *
 * - raw=false → ''（既存）
 * - raw=true, rawExceptSelected=undefined → '_raw'（既存）
 * - raw=true, rawExceptSelected='memo' → '_raw_except_memo'（v2.5 新規・per-field キャッシュ）
 *
 * sanitize: 英数 + _ + - のみ許容（path traversal / 衝突防止・field name は通常 ASCII 想定）。
 */
export function buildRawCacheSuffix(
  raw: boolean,
  rawExceptSelected: string | undefined,
): string {
  if (!raw) return ''
  if (rawExceptSelected === undefined) return '_raw'
  const safe = rawExceptSelected.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `_raw_except_${safe}`
}
