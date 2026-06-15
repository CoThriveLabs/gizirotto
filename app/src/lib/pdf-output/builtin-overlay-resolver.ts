/**
 * builtin テンプレの「templates.fields（bbox 欠落）+ bbox_overrides（DB・ユーザー編集差分）
 * + bbox JSON fallback（builtin 初期値）」から、bg.png + overlay 合成用 effectiveFields を
 * 構築する pure 関数。
 *
 * 設計意図:
 *   - render-image route の builtin 分岐 / minute-thumbnail の builtin 分岐の 2 箇所で
 *     同じ補完ロジックが必要になるため、両者で 1:1 同型を保つよう pure 関数として共有する。
 *   - bbox は dbOverrides（ユーザー編集尊重）→ template.bbox（テンプレ素値）→ fallback JSON
 *     （builtin 初期値）の優先順で解決する。座標 4 軸（x/y/w/h）のいずれかが解決できない
 *     field は描画スキップ（座標誤焼き込み回避）。
 *   - 副作用ゼロ・I/O ゼロ・型は素の number のみで完結。
 *
 * user テンプレ経路（raw PDF 起点）は本関数を一切使わない。
 */
import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'
import type { FieldOverride } from '@/lib/pdf-output/field-override'
import { buildPdfFieldFromDefaults } from '@/lib/pdf-output/bbox-save'

export interface BuiltinBboxJsonEntry {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 1 つの座標値（x/y/w/h いずれか）を「dbOverrides → tplBbox → fallbackJson」の優先順で解決する。
 * いずれにも数値が無ければ undefined を返し、呼出側で field 全体を描画スキップさせる。
 */
function resolveAxis(
  fromOverride: number | undefined,
  fromTplBbox: unknown,
  fromFallback: number | undefined,
): number | undefined {
  if (typeof fromOverride === 'number' && Number.isFinite(fromOverride)) return fromOverride
  if (typeof fromTplBbox === 'number' && Number.isFinite(fromTplBbox)) return fromTplBbox
  if (typeof fromFallback === 'number' && Number.isFinite(fromFallback)) return fromFallback
  return undefined
}

/**
 * builtin テンプレ用 effectiveFields 構築の pure 関数。
 *
 * - 入力 tplFields は seed.sql 由来で bbox を持たない（or 数値が欠ける）ことが多い。
 * - dbOverrides は ユーザー編集 + builtin 初期 bbox 焼き込みの混合。
 * - fallbackFromJson は public/builtin-templates/{slug}.bbox.json 由来。
 *
 * 戻り値の PdfField[] は bbox.page=1 固定（builtin は 1 ページ前提）。
 */
export function buildBuiltinEffectiveFields(input: {
  tplFields: PdfField[]
  dbOverrides: Record<string, FieldOverride>
  fallbackFromJson: Record<string, BuiltinBboxJsonEntry> | null
}): PdfField[] {
  const { tplFields, dbOverrides, fallbackFromJson } = input
  const out: PdfField[] = []
  for (const tf of tplFields) {
    const ov = dbOverrides[tf.name]
    const fb = fallbackFromJson?.[tf.name]
    // builtin の templates.fields は seed.sql で bbox プロパティを持たない場合があるため、
    // `?? {}` で null 安全化。bbox 欠落時は tplBbox 由来の解決を全軸スキップして
    // dbOverrides → fallbackFromJson にだけ降りるようにする。
    const tplBbox = (tf.bbox as Record<string, unknown> | undefined) ?? {}
    const x = resolveAxis(ov?.x, tplBbox.x, fb?.x)
    const y = resolveAxis(ov?.y, tplBbox.y, fb?.y)
    const w = resolveAxis(ov?.w, tplBbox.w, fb?.w)
    const h = resolveAxis(ov?.h, tplBbox.h, fb?.h)
    if (x === undefined || y === undefined || w === undefined || h === undefined) {
      // bbox 未確定 field は描画スキップ（座標 0 で焼くと表紙の左上に出てしまう）。
      continue
    }
    // builtin の templates.fields は seed.sql で bbox 以外の PdfField 必須属性
    // （font / padding / type / max_chars / multiline / font_size_min など）も
    // 持たないことがあり、そのまま下流に渡すと undefined 参照で throw する。
    // `buildPdfFieldFromDefaults` で NEW_FIELD_DEFAULTS を補完する。tf に対応プロパティが
    // あれば spread で上書きされ尊重される。
    out.push(
      buildPdfFieldFromDefaults({
        ...tf,
        bbox: { ...((tf.bbox as object | undefined) ?? {}), x, y, w, h, page: 1 },
      }),
    )
  }
  return out
}
