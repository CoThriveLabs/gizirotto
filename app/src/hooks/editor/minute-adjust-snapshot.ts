import type { BboxOverrides } from '@/lib/pdf-output/field-override'
import type { EditorField } from '@/app/(dashboard)/templates/[id]/bbox-pane'
import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'
import { buildPdfFieldFromDefaults } from '@/lib/pdf-output/bbox-save'
import type { TemplateFieldDef } from '@/app/(dashboard)/minutes/[id]/adjust/adjust-view-helpers'

/**
 * 単一スタック方式の MinutesEditSnapshot。
 * 値 + overrides を 1 ステップに持ち、値編集・位置・サイズ・整形・項目削除すべてを undo 対象に。
 * newFieldNames を snapshot に含めることで「項目追加 → 値入力 → undo」「項目追加 → 削除 → undo」
 * で newFieldNames も復元する（drift 解消）。
 */
export type MinutesEditSnapshot = {
  values: Record<string, string>
  overrides: BboxOverrides
  fields: TemplateFieldDef[]
  newFieldNames: Set<string>
}

export function cloneSnapshot(s: MinutesEditSnapshot): MinutesEditSnapshot {
  return {
    values: { ...s.values },
    overrides: Object.fromEntries(
      Object.entries(s.overrides).map(([k, v]) => [k, { ...v }]),
    ),
    fields: s.fields.map((f) => ({ ...f, bbox: { ...f.bbox } })),
    newFieldNames: new Set(s.newFieldNames),
  }
}

export function snapshotsEqual(
  a: MinutesEditSnapshot,
  b: MinutesEditSnapshot,
): boolean {
  // values
  const aKeys = Object.keys(a.values)
  const bKeys = Object.keys(b.values)
  if (aKeys.length !== bKeys.length) return false
  for (const k of aKeys) if (a.values[k] !== b.values[k]) return false
  // overrides
  const aoKeys = Object.keys(a.overrides)
  const boKeys = Object.keys(b.overrides)
  if (aoKeys.length !== boKeys.length) return false
  for (const k of aoKeys) {
    const av = a.overrides[k]
    const bv = b.overrides[k]
    if (!bv) return false
    if (
      av.x !== bv.x ||
      av.y !== bv.y ||
      av.w !== bv.w ||
      av.h !== bv.h ||
      av.fontSize !== bv.fontSize
    )
      return false
  }
  // fields（name 集合の差分判定で必要十分・bbox は overrides 経由で評価）
  if (a.fields.length !== b.fields.length) return false
  for (let i = 0; i < a.fields.length; i++) {
    if (a.fields[i].name !== b.fields[i].name) return false
  }
  // newFieldNames 集合差分（追加 → 削除 → undo の drift 検知）。
  if (a.newFieldNames.size !== b.newFieldNames.size) return false
  for (const n of a.newFieldNames) if (!b.newFieldNames.has(n)) return false
  return true
}

/**
 * TemplateFieldDef[] を BboxPane が必要とする EditorField[] に変換（pt 空間維持）。
 * AdjustView は 1 ページ前提。
 */
export function toEditorFields(
  fields: TemplateFieldDef[],
  overrides: BboxOverrides,
  pageNumber: number,
): EditorField[] {
  return fields.map((f) => {
    const o = overrides[f.name]
    return {
      name: f.name,
      label: f.label,
      bbox: {
        x: o?.x ?? f.bbox.x,
        y: o?.y ?? f.bbox.y,
        w: o?.w ?? f.bbox.w,
        h: o?.h ?? f.bbox.h,
        page: pageNumber,
      },
    }
  })
}

/**
 * name で実 PdfField を引いて bbox.page だけ揃えた派生を返す。実テンプレの
 * padding / font.size / multiline / font_size_min をそのまま保つことで、canvas 経路の
 * wrap maxW（= bbox.w - padding.left - padding.right）が PDF 経路（overlay-generator →
 * fitting.ts）と完全一致する。実 PdfField が無い name は null を返し、呼出側でスキップ。
 */
export function lookupPdfField(
  pdfFields: PdfField[],
  name: string,
  pageNumber: number,
): PdfField | null {
  const found = pdfFields.find((p) => p.name === name)
  if (!found) return null
  if (found.bbox.page === pageNumber) return found
  return { ...found, bbox: { ...found.bbox, page: pageNumber } }
}

/**
 * 新規追加 field（newFieldNames）の PdfField を runtime で合成する。pdfFields は initial 不変
 * （props 由来）のため、追加直後の新規 field を lookupPdfField で引くと null になる。
 * buildPdfFieldFromDefaults で属性補完して canvas 動的プレビューに乗せる。
 */
export function synthesizePdfFieldFromTemplateDef(
  f: TemplateFieldDef,
  pageNumber: number,
): PdfField {
  return buildPdfFieldFromDefaults({
    name: f.name,
    label: f.label,
    bbox: { page: pageNumber, x: f.bbox.x, y: f.bbox.y, w: f.bbox.w, h: f.bbox.h },
    multiline: f.multiline ?? false,
  })
}

/**
 * lookupPdfField が null（新規追加 field のため pdfFields に無い）の場合に、
 * TemplateFieldDef から runtime PdfField を生成して返す。既存 field（lookup ヒット）は
 * ヒット側を優先する（本関数は新規 field のみ対象）。
 */
export function resolveEffectivePdfField(
  pdfFields: PdfField[],
  field: TemplateFieldDef,
  pageNumber: number,
): PdfField {
  const found = lookupPdfField(pdfFields, field.name, pageNumber)
  if (found) return found
  return synthesizePdfFieldFromTemplateDef(field, pageNumber)
}
