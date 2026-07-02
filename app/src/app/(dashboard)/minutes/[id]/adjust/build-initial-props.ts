import 'server-only'

import type { TemplateFieldDef } from './adjust-view-helpers'
import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'
import { PdfFieldSchemaZ } from '@/lib/ai/schemas/pdf-field-schema'
import {
  parseFieldOverrides,
  type BboxOverrides,
} from '@/lib/pdf-output/field-override'
import {
  mergeTemplateAndNewFields,
  parseNewFields,
} from '@/lib/pdf-output/merge-template-and-new-fields'
import {
  loadBuiltinBboxOverrides,
  resolveBuiltinBboxSlugFromProcessedPath,
} from '@/lib/builtin-bbox-loader'

/**
 * AdjustView 初期 props 構築（純関数群）。
 *
 * adjust/page.tsx（ログイン議事録）と、builtin テンプレを直接開くゲスト用エントリの
 * 両方から呼べるよう、「テンプレ + 議事録由来の値（または空の初期値）」から AdjustView の
 * props 形をまとめて組み立てる。ログイン経路は本ファイル抽出前と完全に同じ計算結果を返す
 * （関数を移しただけで計算式は変えていない）。
 */

/** getTemplate() 結果のうち本モジュールが読む列だけの構造的部分型。 */
export interface AdjustTemplateRow {
  fields: unknown
  fixed_texts: unknown
  family_id?: string | null
  processed_path?: string | null
}

export interface AdjustInitialProps {
  fields: TemplateFieldDef[]
  pdfFields: PdfField[]
  initialOverrides: BboxOverrides
  initialValues: Record<string, string>
  fixedTextSizesPt: number[]
}

export interface BuildAdjustInitialPropsInput {
  template: AdjustTemplateRow
  /** 議事録 content_json。ゲストの新規表示時は空オブジェクトを渡す。 */
  contentJson: unknown
  /** 議事録 bbox_overrides。ゲストの新規表示時は空オブジェクトを渡す。 */
  bboxOverridesRaw: unknown
  /** 議事録 new_fields。ゲストの新規表示時は未指定でよい。 */
  newFieldsRaw: unknown
}

/**
 * テンプレ + 議事録由来の値から AdjustView 初期 props をまとめて構築する。
 *
 * builtin テンプレ（family_id === null）は templates.fields に bbox を持たない（seed 由来）。
 * bboxOverridesRaw に値が無い field は、bbox JSON（public/builtin-templates/{slug}.bbox.json）の
 * 初期座標で補う。これにより、既存議事録・新規ゲストいずれも同じ「テンプレ既定レイアウト」を
 * 同一ロジックで再現できる。
 */
export async function buildAdjustInitialProps(
  input: BuildAdjustInitialPropsInput,
): Promise<AdjustInitialProps> {
  const { template, contentJson, bboxOverridesRaw, newFieldsRaw } = input

  // partial 後方互換: 旧 `{x,y}` のみ override も partial も両方受け入れる。
  const initialOverrides = parseFieldOverrides(bboxOverridesRaw)

  // builtin テンプレ × bbox 未確定（旧議事録 or 新規表示）でも、サーバ側で bbox JSON を
  //   読み込み bboxFallback に合流させる。これにより seed.sql で bbox を持たない field が
  //   AdjustView で「描画されない（fields から脱落）」問題を構造的に解消する。
  //
  //   合流ポリシー: initialOverrides（編集差分）を最優先。bbox JSON 側は欠落 key の補完のみ。
  //   手で動かした座標は絶対に上書きしない。
  //
  //   user テンプレ（family_id !== null）には触れない＝副作用ゼロ。
  let builtinBboxFallbackFromJson: Record<
    string,
    { x: number; y: number; w: number; h: number }
  > | null = null
  if (template && template.family_id === null) {
    const slug = resolveBuiltinBboxSlugFromProcessedPath(
      template.processed_path ?? null,
    )
    if (slug) {
      try {
        builtinBboxFallbackFromJson = await loadBuiltinBboxOverrides(slug)
      } catch {
        // fs 読込失敗は無視（既存挙動に劣化させない）
      }
    }
  }

  // builtin テンプレは templates.fields に bbox が無い（seed 由来）。bbox_overrides に
  //   初期 bbox が焼き込まれていればそれを、無ければ bbox JSON を fields の bbox 欠落 fallback
  //   として渡し、AdjustView 起動時の「fields 0 個」問題を解消する。user テンプレは bbox が
  //   DB に揃っているため fallback は使われず副作用ゼロ。
  const bboxFallbackForFields: Record<
    string,
    { x: number; y: number; w: number; h: number }
  > = {}
  // JSON 側を先に merge し、その後 initialOverrides で上書き（編集差分を最優先）。
  if (builtinBboxFallbackFromJson) {
    for (const [name, v] of Object.entries(builtinBboxFallbackFromJson)) {
      bboxFallbackForFields[name] = { x: v.x, y: v.y, w: v.w, h: v.h }
    }
  }
  for (const [name, ov] of Object.entries(initialOverrides)) {
    if (
      ov &&
      typeof ov.x === 'number' &&
      typeof ov.y === 'number' &&
      typeof ov.w === 'number' &&
      typeof ov.h === 'number'
    ) {
      bboxFallbackForFields[name] = { x: ov.x, y: ov.y, w: ov.w, h: ov.h }
    }
  }

  const tplFields = extractFieldDefs(template.fields, bboxFallbackForFields)
  const tplPdfFields = extractPdfFields(template.fields, tplFields)
  // テンプレ固定テキストの font.size 群（pt）を抽出し AdjustView へ渡す。
  //   canvas プレビューの uniform 算出（computeUniformFontSize）が PDF/画像経路と同一の
  //   snap を通る（3 経路一致）。テンプレ非破壊（読み取りのみ）。
  const fixedTextSizesPt = extractFixedTextSizesPt(template.fixed_texts)
  // minute 固有の追加 field を末尾合流。
  //   - PdfField[] レベルでテンプレ + newFields を統合し、AdjustView は newFields の存在を
  //     意識しない。canvas / PDF / 画像 3 経路すべて同一 fields 集合で動く。
  //   - 追加 field が無ければ tplPdfFields をそのまま返す（不変・後方互換）。
  const newFieldsParsed = parseNewFields(newFieldsRaw)
  const pdfFields = mergeTemplateAndNewFields(tplPdfFields, newFieldsParsed)
  // TemplateFieldDef[] も同じ name 集合になるよう、merge 後 pdfFields から再生成する。
  //   採番再確定で name が変わる可能性があるため、newFields 側は tplFields の派生では作れない。
  const fields: TemplateFieldDef[] = pdfFields.map((pf) => ({
    name: pf.name,
    label: pf.label,
    bbox: { x: pf.bbox.x, y: pf.bbox.y, w: pf.bbox.w, h: pf.bbox.h },
    multiline: pf.multiline ?? false,
  }))
  const initialValues = parseContentValues(contentJson, fields)

  return { fields, pdfFields, initialOverrides, initialValues, fixedTextSizesPt }
}

export function extractFieldDefs(
  raw: unknown,
  bboxFallback?: Record<string, { x: number; y: number; w: number; h: number }>,
): TemplateFieldDef[] {
  if (!raw) return []
  // Phase 5a 旧テンプレ (ARRAY) と新形式 ({fields:[]}) 両対応 (B-5/B-6 救済)
  const fieldsArr: unknown = Array.isArray(raw)
    ? raw
    : typeof raw === 'object'
      ? (raw as { fields?: unknown }).fields
      : null
  if (!Array.isArray(fieldsArr)) return []
  const out: TemplateFieldDef[] = []
  for (const f of fieldsArr) {
    if (!f || typeof f !== 'object') continue
    const obj = f as Record<string, unknown>
    const name = typeof obj.name === 'string' ? obj.name : null
    if (!name) continue
    const bbox = obj.bbox as Record<string, unknown> | undefined
    // builtin テンプレは fields に bbox を持たない（seed.sql 由来・DB マイグレ無しポリシー）。
    //   bboxFallback（= minute.bbox_overrides に焼き込み済の builtin 初期 bbox）が渡されていれば、
    //   それで field 自体を救う。AdjustView の `o?.x ?? f.bbox.x` 経路でユーザー編集後の
    //   override が優先されるため、ここで入れる値はデフォルト座標として使われるのみ。
    let x: number | null = null
    let y: number | null = null
    let w = 100
    let h = 20
    if (bbox) {
      x = typeof bbox.x === 'number' ? bbox.x : null
      y = typeof bbox.y === 'number' ? bbox.y : null
      w = typeof bbox.w === 'number' ? bbox.w : 100
      h = typeof bbox.h === 'number' ? bbox.h : 20
    }
    if ((x === null || y === null) && bboxFallback && bboxFallback[name]) {
      const fb = bboxFallback[name]
      x = fb.x
      y = fb.y
      w = fb.w
      h = fb.h
    }
    if (x === null || y === null) continue
    // multiline は textarea ↔ input の分岐に使う（既定 false・未指定なら text と同等）。
    const multiline =
      typeof obj.multiline === 'boolean' ? obj.multiline : false
    out.push({
      name,
      label:
        typeof obj.label_ja === 'string'
          ? obj.label_ja
          : typeof obj.label === 'string'
            ? obj.label
            : name,
      bbox: { x, y, w, h },
      multiline,
    })
  }
  return out
}

/**
 * テンプレ DB の実 PdfField[] を抽出する。
 *
 * canvas 経路（AdjustView dynamicFieldValues → field-values-composite-canvas）と PDF 経路
 * （regenerate-minute-pdf → overlay-generator）で padding / font.size / multiline /
 * font_size_min を完全同型化するための入口。実テンプレ値を取り出して props 経由で渡すことで、
 * canvas 側の wrap 幅計算と PDF 出力の wrap 幅計算を一致させる。
 *
 * `fields`（extractFieldDefs 結果）と同じ順・同じ name 集合を保つ。raw 側に対応する PdfField が
 * 無い / parse 失敗時は zod default で安全な PdfField を組み立てる（page=1 固定・適合）。
 */
export function extractPdfFields(
  raw: unknown,
  fields: TemplateFieldDef[],
): PdfField[] {
  // raw を { name -> 生 jsonb } マップに正規化（extractFieldDefs と同じ走査）。
  const fieldsArr: unknown = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? (raw as { fields?: unknown }).fields
      : null
  const byName = new Map<string, Record<string, unknown>>()
  if (Array.isArray(fieldsArr)) {
    for (const f of fieldsArr) {
      if (!f || typeof f !== 'object') continue
      const obj = f as Record<string, unknown>
      const name = typeof obj.name === 'string' ? obj.name : null
      if (!name) continue
      byName.set(name, obj)
    }
  }
  const out: PdfField[] = []
  for (const f of fields) {
    const raw = byName.get(f.name)
    if (raw) {
      // zod safeParse で実テンプレ padding / font.size / font_size_min を尊重しつつ、
      // bbox.page が無い旧データは page=1 補完（adjust 画面は 1 ページ前提）。
      const candidate: Record<string, unknown> = { ...raw }
      const candidateBbox = candidate.bbox as Record<string, unknown> | undefined
      if (candidateBbox && typeof candidateBbox.page !== 'number') {
        candidate.bbox = { ...candidateBbox, page: 1 }
      }
      const parsed = PdfFieldSchemaZ.safeParse(candidate)
      if (parsed.success) {
        out.push(parsed.data)
        continue
      }
    }
    // フォールバック: 実テンプレに PdfField 形が無い旧データ（docx 等）。padding は zod default
    // ({4,4,4,4}) を採用 → overlay-generator も同様に default の意味だと解釈するので一致。
    const fallback = PdfFieldSchemaZ.parse({
      name: f.name,
      label: f.label,
      type: 'text',
      bbox: { page: 1, x: f.bbox.x, y: f.bbox.y, w: f.bbox.w, h: f.bbox.h },
      max_chars: 200,
      font: { family: 'NotoSansJP', size: 12 },
      multiline: f.multiline ?? false,
      font_size_min: 8,
    })
    out.push(fallback)
  }
  return out
}

/**
 * templates.fixed_texts（jsonb）から font.size 群（pt）を抽出する。テンプレ非破壊・読取専用。
 *
 * - 配列以外、要素が object でない、font.size が number でないものは黙って除外する
 *   （uniform-size.ts 側でも本文サイズ帯フィルタが走るため二重防御）。
 * - 0 件なら空配列を返す → AdjustView 側で snap 無効＝後方互換。
 */
export function extractFixedTextSizesPt(raw: unknown): number[] {
  if (!Array.isArray(raw)) return []
  const out: number[] = []
  for (const ft of raw) {
    if (!ft || typeof ft !== 'object') continue
    const font = (ft as { font?: unknown }).font
    if (!font || typeof font !== 'object') continue
    const size = (font as { size?: unknown }).size
    if (typeof size === 'number' && Number.isFinite(size) && size > 0) {
      out.push(size)
    }
  }
  return out
}

/**
 * content_json から各 field の初期値を取り出す。型不整合や欠損は空文字へフォールバックし、
 * AdjustView 側は常に Record<string, string> として扱える（textarea の controlled 化のため）。
 *
 * hydration 回帰防止のため export し、unit test から直接呼べるようにする。
 */
export function parseContentValues(
  raw: unknown,
  fields: TemplateFieldDef[],
): Record<string, string> {
  const out: Record<string, string> = {}
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  for (const f of fields) {
    const v = src[f.name]
    out[f.name] = typeof v === 'string' ? v : v == null ? '' : String(v)
  }
  return out
}
