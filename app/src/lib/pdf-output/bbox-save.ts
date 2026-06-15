/**
 * bbox 保存の純粋ロジック。
 *
 * Server Action（updateTemplateFieldsBbox）から DB I/O を分離した純関数群。
 * unit テスト可能にするため、Supabase 非依存で「現 DB fields + クライアント更新」から
 * 「保存すべき fields 配列」を組み立てる / バリデーションする処理をここに集約する。
 *
 * 破壊耐性の核:
 *   - bbox 以外の属性（label/type/font/padding…）は現 DB 値を温存（bbox のみ差替）。
 *   - mergeBboxUpdates では field の name 集合が現 DB と完全一致でなければエラー。
 *   - bbox はページ範囲内・w/h>0。
 */
import { z } from 'zod'
import {
  PdfFieldBboxSchema,
  type PdfFieldBbox,
  type PdfField,
} from '@/lib/ai/schemas/pdf-field-schema'
import { isBboxWithinPage, type PageMeta } from './bbox-coords'

/** クライアントから受け取る最小ペイロード（name と bbox のみ。他属性は無視）。 */
export const BboxUpdateItemSchema = z.object({
  name: z.string().min(1),
  bbox: PdfFieldBboxSchema,
})
export type BboxUpdateItem = z.infer<typeof BboxUpdateItemSchema>

export const BboxUpdatePayloadSchema = z.array(BboxUpdateItemSchema).min(1).max(20)

// ──────────────────────────────────────────────────────────────────────────
// 全 field スナップショット送信方式
//
// クライアントは編集後の全 field（追加/分割/削除/更新を反映済み）を送り、サーバが
// 現 DB との差分（UPDATE / DELETE / INSERT）を判定して反映する。
//   - label / isNew / labelDirty は任意（後方互換）。現行クライアントが {name,bbox}[] を
//     送っている間は、全要素が「既存 name の UPDATE」になり mergeBboxUpdates と同じ結果になる。
//   - 新 field の属性補完は AI/OCR を使わず、既存 field の値流用 or 定数のみ。
// ──────────────────────────────────────────────────────────────────────────

/** 1 field スナップショット。label/isNew/labelDirty は任意（後方互換）。 */
export const FieldSnapshotItemSchema = z.object({
  name: z.string().min(1),
  bbox: PdfFieldBboxSchema,
  /** 日本語ラベル（追加/分割の新規入力。既存 UPDATE では送られても原則温存）。 */
  label: z.string().optional(),
  /** true = クライアント新規（DB に無い）→ INSERT 候補。 */
  isNew: z.boolean().optional(),
  /** true = この既存 field の label 差替を許可（分割の左枠などの例外）。 */
  labelDirty: z.boolean().optional(),
})
export type FieldSnapshotItem = z.infer<typeof FieldSnapshotItemSchema>

export const FieldsSnapshotPayloadSchema = z
  .array(FieldSnapshotItemSchema)
  .min(1)
  .max(20)

/** 新 field 属性のデフォルト補完値（非 AI）。 */
export const NEW_FIELD_DEFAULTS = {
  type: 'text' as const,
  max_chars: 100,
  // overlay レンダラは常に Noto Sans CJK JP を embed（family は実質ラベル）。
  // テンプレ内に既存 font があればそれを流用し、無ければこの既定を使う。
  font: { family: 'NotoSansJP', size: 10.5 },
  padding: { left: 4, top: 4, right: 4, bottom: 4 },
  multiline: false,
  align: 'left' as const,
  vertical: 'top' as const,
  writing_mode: 'horizontal' as const,
  overflow_strategy: 'shrink_then_wrap' as const,
  font_size_min: 8,
}

/**
 * NEW_FIELD_DEFAULTS で属性既定を補完した PdfField を1つ組む（既定値の単一ソース化）。
 *
 * name/label/bbox は呼び出し側必須。font 等を partial で渡せば上書き、未指定なら既定。
 * 振る舞いは従来の手書き展開と等価（type/max_chars/padding/multiline/align/...）。
 */
export function buildPdfFieldFromDefaults(
  partial: Pick<PdfField, 'name' | 'label' | 'bbox'> & Partial<PdfField>,
): PdfField {
  return {
    type: NEW_FIELD_DEFAULTS.type,
    max_chars: NEW_FIELD_DEFAULTS.max_chars,
    font: { ...NEW_FIELD_DEFAULTS.font },
    padding: { ...NEW_FIELD_DEFAULTS.padding },
    multiline: NEW_FIELD_DEFAULTS.multiline,
    align: NEW_FIELD_DEFAULTS.align,
    vertical: NEW_FIELD_DEFAULTS.vertical,
    writing_mode: NEW_FIELD_DEFAULTS.writing_mode,
    overflow_strategy: NEW_FIELD_DEFAULTS.overflow_strategy,
    font_size_min: NEW_FIELD_DEFAULTS.font_size_min,
    ...partial,
  }
}

const LABEL_MAX = 40
const FIELDS_MIN = 1
const FIELDS_MAX = 20

/**
 * 既存 name 集合と衝突しない最小の `field_N` を採番する（楽観採番）。
 *
 * AdjustView「項目を追加」と templates の両方から呼ぶ（1:1 共有）。
 * サーバ側 nextFieldName と同じ規則（衝突時はサーバが再採番するため楽観で十分）。
 */
export function nextClientFieldName(used: Set<string>): string {
  for (let n = 1; ; n++) {
    const candidate = `field_${n}`
    if (!used.has(candidate)) return candidate
  }
}

/**
 * 空 label の仮置き「項目N」（N = 既存項目数 + 1）。
 * AdjustView「項目を追加」と templates の両方から呼ぶ（1:1 共有）。
 */
export function placeholderLabel(existingCount: number): string {
  return `項目${existingCount + 1}`
}

/** bbox を持つ現 DB field（name + bbox は必須、その他は温存対象）。 */
export interface DbFieldWithBbox {
  name: string
  bbox: PdfFieldBbox
  [key: string]: unknown
}

export type MergeResult =
  | { ok: true; fields: DbFieldWithBbox[] }
  | { ok: false; error: BboxSaveError }

export type BboxSaveError =
  | 'NAME_SET_MISMATCH'
  | 'BBOX_OUT_OF_RANGE'
  | 'PAGE_NOT_FOUND'
  | 'NO_BBOX_FIELDS'
  // 全 field スナップショット送信時のエラー種別。
  | 'FIELD_COUNT_OUT_OF_RANGE'
  | 'INVALID_LABEL'
  | 'NAME_GEN_FAILED'

/**
 * 現 DB fields のうち bbox を持つものだけ抽出（discriminated union の bbox 有り側）。
 */
export function pickBboxFields(dbFields: unknown[]): DbFieldWithBbox[] {
  return dbFields.filter(
    (f): f is DbFieldWithBbox =>
      f !== null &&
      typeof f === 'object' &&
      'name' in f &&
      'bbox' in f &&
      (f as { bbox: unknown }).bbox !== null &&
      typeof (f as { bbox: unknown }).bbox === 'object',
  )
}

/**
 * 現 DB fields に対し、クライアント更新の bbox だけを差し替えた新 fields 配列を組む。
 *
 * - name 集合が完全一致しなければ NAME_SET_MISMATCH。
 * - 各 bbox がその page の pageSizes 範囲内でなければ BBOX_OUT_OF_RANGE。
 * - bbox 以外の属性は dbFields の値を温存。
 * - bbox を持たない field（docx 由来等）は対象外として現状維持（並び順保持）。
 *
 * @param dbFields  現 DB の fields（bbox 有り・無し混在しうる）
 * @param updates   クライアント更新（name + bbox）
 * @param pageSizes 範囲チェック用ページメタ
 */
export function mergeBboxUpdates(
  dbFields: unknown[],
  updates: BboxUpdateItem[],
  pageSizes: PageMeta[],
): MergeResult {
  const bboxFields = pickBboxFields(dbFields)
  if (bboxFields.length === 0) {
    return { ok: false, error: 'NO_BBOX_FIELDS' }
  }

  // name 集合の完全一致チェック（bbox を持つ field 集合 == 更新対象集合）。
  const dbNames = new Set(bboxFields.map((f) => f.name))
  const updateNames = new Set(updates.map((u) => u.name))
  if (
    dbNames.size !== updateNames.size ||
    [...dbNames].some((n) => !updateNames.has(n))
  ) {
    return { ok: false, error: 'NAME_SET_MISMATCH' }
  }

  const pageByNum = new Map(pageSizes.map((p) => [p.page, p]))
  const updateByName = new Map(updates.map((u) => [u.name, u.bbox]))

  // dbFields の並び順を保持しつつ、bbox 有り field は bbox を差替、それ以外は温存。
  const merged: DbFieldWithBbox[] = []
  for (const f of dbFields) {
    if (
      f === null ||
      typeof f !== 'object' ||
      !('name' in f) ||
      !('bbox' in f) ||
      (f as { bbox: unknown }).bbox === null
    ) {
      // bbox を持たない field はそのまま温存（型は緩く DbFieldWithBbox に含めない）。
      merged.push(f as DbFieldWithBbox)
      continue
    }
    const field = f as DbFieldWithBbox
    const newBbox = updateByName.get(field.name)
    if (!newBbox) {
      // ここに来るのは name 集合一致チェックを通過済なので通常起きない（防御）。
      return { ok: false, error: 'NAME_SET_MISMATCH' }
    }
    const meta = pageByNum.get(newBbox.page)
    if (!meta) {
      return { ok: false, error: 'PAGE_NOT_FOUND' }
    }
    if (!isBboxWithinPage(newBbox, meta)) {
      return { ok: false, error: 'BBOX_OUT_OF_RANGE' }
    }
    // bbox のみ差替、他属性は温存。
    merged.push({ ...field, bbox: newBbox })
  }

  return { ok: true, fields: merged }
}

// ──────────────────────────────────────────────────────────────────────────
// mergeFieldsSnapshot（全 field スナップショット差分判定）
// ──────────────────────────────────────────────────────────────────────────

/** 既存 DB field から流用する font を最頻で選ぶ。無ければ既定。 */
function pickDefaultFont(bboxFields: DbFieldWithBbox[]): { family: string; size: number } {
  const counts = new Map<string, { font: { family: string; size: number }; n: number }>()
  for (const f of bboxFields) {
    const font = f.font as { family?: unknown; size?: unknown } | undefined
    if (
      font &&
      typeof font.family === 'string' &&
      typeof font.size === 'number' &&
      font.size > 0
    ) {
      const key = `${font.family}|${font.size}`
      const cur = counts.get(key)
      if (cur) cur.n += 1
      else counts.set(key, { font: { family: font.family, size: font.size }, n: 1 })
    }
  }
  let best: { font: { family: string; size: number }; n: number } | null = null
  for (const v of counts.values()) {
    if (!best || v.n > best.n) best = v
  }
  return best ? best.font : { ...NEW_FIELD_DEFAULTS.font }
}

/** `field_N` の最小の空き連番を採番（既存 used 集合と衝突しない最小）。max 到達で null。 */
function nextFieldName(used: Set<string>): string | null {
  for (let n = 1; n <= FIELDS_MAX + 1; n++) {
    const candidate = `field_${n}`
    if (!used.has(candidate)) return candidate
  }
  return null
}

/** label が 1〜LABEL_MAX 文字か（前後空白は trim 後で判定）。 */
function isValidLabel(label: string | undefined): label is string {
  if (typeof label !== 'string') return false
  const t = label.trim()
  return t.length >= 1 && t.length <= LABEL_MAX
}

/**
 * 全 field スナップショットを現 DB fields と突き合わせ、UPDATE/DELETE/INSERT を反映した
 * 新 fields 配列を組む。Supabase 非依存の純関数。
 *
 * 反映規則:
 *   - UPDATE（DB にあり・スナップショットにもある name、isNew でない）:
 *       既存 field の bbox を差替。label/font/padding/type 等は現 DB 値を温存。
 *       例外: labelDirty=true のとき label のみユーザー入力で差替（分割左枠など）。
 *   - DELETE（DB にあり・スナップショットに無い name）: 結果から除外。
 *   - INSERT（isNew=true・name が DB に無い）: 新 field を生成し属性デフォルト補完。
 *
 * 採番: クライアント楽観採番 `field_N` が既存 name や他の新規と衝突する場合、サーバで
 *       次の空き連番へ再採番（楽観採番→サーバ確定）。
 * 検証: 反映後件数 min1/max20（FIELD_COUNT_OUT_OF_RANGE）・bbox 範囲（BBOX_OUT_OF_RANGE/
 *       PAGE_NOT_FOUND）・新規/差替 label 1-40（INVALID_LABEL）・採番不能（NAME_GEN_FAILED）。
 *
 * 並び順: 既存 field は DB の並びを保持（bbox 無し field も温存）、新規 field は末尾に
 *         スナップショットの出現順で追加する。
 */
export function mergeFieldsSnapshot(
  dbFields: unknown[],
  snapshot: FieldSnapshotItem[],
  pageSizes: PageMeta[],
): MergeResult {
  const bboxFields = pickBboxFields(dbFields)
  if (bboxFields.length === 0) {
    return { ok: false, error: 'NO_BBOX_FIELDS' }
  }

  const pageByNum = new Map(pageSizes.map((p) => [p.page, p]))
  const dbNames = new Set(bboxFields.map((f) => f.name))

  // スナップショットを「既存 UPDATE 対象」と「新規 INSERT 対象」に振り分け。
  // 既存判定は「isNew でない && name が DB に存在」。それ以外（isNew or DB に無い）は新規扱い。
  const updateByName = new Map<string, FieldSnapshotItem>()
  const inserts: FieldSnapshotItem[] = []
  for (const item of snapshot) {
    const isExisting = !item.isNew && dbNames.has(item.name)
    if (isExisting) {
      updateByName.set(item.name, item)
    } else {
      inserts.push(item)
    }
  }

  // bbox 範囲チェック（snapshot 全件・既存/新規問わず）。
  function checkBbox(bbox: PdfFieldBbox): BboxSaveError | null {
    const meta = pageByNum.get(bbox.page)
    if (!meta) return 'PAGE_NOT_FOUND'
    if (!isBboxWithinPage(bbox, meta)) return 'BBOX_OUT_OF_RANGE'
    return null
  }

  // 採番のための used 集合: 既存 DB の全 name（bbox 無し含む）＋これから確定する新規 name。
  const used = new Set<string>()
  for (const f of dbFields) {
    if (f && typeof f === 'object' && 'name' in f) {
      const n = (f as { name: unknown }).name
      if (typeof n === 'string') used.add(n)
    }
  }

  const defaultFont = pickDefaultFont(bboxFields)

  // 1) 既存 field を DB 並び順で反映（UPDATE は bbox 差替＋labelDirty 時 label 差替、
  //    スナップショットに無い既存 bbox field は DELETE＝除外、bbox 無し field は温存）。
  const merged: DbFieldWithBbox[] = []
  for (const f of dbFields) {
    const hasBbox =
      f !== null &&
      typeof f === 'object' &&
      'name' in f &&
      'bbox' in f &&
      (f as { bbox: unknown }).bbox !== null &&
      typeof (f as { bbox: unknown }).bbox === 'object'

    if (!hasBbox) {
      // bbox を持たない field（docx 由来等）はそのまま温存。
      merged.push(f as DbFieldWithBbox)
      continue
    }

    const field = f as DbFieldWithBbox
    const upd = updateByName.get(field.name)
    if (!upd) {
      // スナップショットに無い既存 bbox field ＝ DELETE。
      continue
    }
    const bboxErr = checkBbox(upd.bbox)
    if (bboxErr) return { ok: false, error: bboxErr }

    if (upd.labelDirty) {
      // 例外: 分割左枠など、明示フラグ時のみ既存 label を差替（要バリデーション）。
      if (!isValidLabel(upd.label)) return { ok: false, error: 'INVALID_LABEL' }
      merged.push({ ...field, bbox: upd.bbox, label: upd.label!.trim() })
    } else {
      // 通常 UPDATE: bbox のみ差替、label を含む他属性は温存。
      merged.push({ ...field, bbox: upd.bbox })
    }
  }

  // 2) 新規 field を末尾に追加（INSERT・属性デフォルト補完＋衝突再採番）。
  for (const item of inserts) {
    const bboxErr = checkBbox(item.bbox)
    if (bboxErr) return { ok: false, error: bboxErr }
    if (!isValidLabel(item.label)) return { ok: false, error: 'INVALID_LABEL' }

    // name 採番: クライアント楽観 name が形式 OK かつ未使用ならそのまま、
    // 衝突 or 形式不正ならサーバで次の空き field_N へ再採番。
    let name = item.name
    const validForm = /^[a-z_][a-z0-9_]*$/.test(name) && name.length <= 40
    if (!validForm || used.has(name)) {
      const gen = nextFieldName(used)
      if (!gen) return { ok: false, error: 'NAME_GEN_FAILED' }
      name = gen
    }
    used.add(name)

    merged.push(
      buildPdfFieldFromDefaults({
        name,
        label: item.label.trim(),
        bbox: item.bbox,
        font: { ...defaultFont },
      }),
    )
  }

  // 3) 件数ガード（bbox を持つ field ベースで min1/max20。bbox 無し docx field は数えない）。
  const bboxCount = merged.filter(
    (f) =>
      f &&
      typeof f === 'object' &&
      'bbox' in f &&
      (f as { bbox: unknown }).bbox !== null &&
      typeof (f as { bbox: unknown }).bbox === 'object',
  ).length
  if (bboxCount < FIELDS_MIN || bboxCount > FIELDS_MAX) {
    return { ok: false, error: 'FIELD_COUNT_OUT_OF_RANGE' }
  }

  return { ok: true, fields: merged }
}
