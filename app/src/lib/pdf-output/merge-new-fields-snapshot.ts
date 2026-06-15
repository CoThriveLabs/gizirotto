/**
 * mergeNewFieldsSnapshot — saveMinuteAdjust の「newFields 差分判定」純関数。
 *
 * 設計書 minutes_adjust_editor_renewal_design_2026-06-08.md §9 段階 2.5c 準拠。
 * templates `bbox-save.ts` `mergeFieldsSnapshot` L271-394 と **完全同型**の
 * INSERT / UPDATE / DELETE 判定。サーバ専用 import なし（pure・ユニットテスト可）。
 *
 * 役割:
 *   AdjustView「項目を追加」で minute 固有の new_fields jsonb 列を編集する際、
 *   クライアントから来た **現在 minute に含まれる newField スナップショット**と
 *   DB の現 new_fields を突き合わせ、INSERT / UPDATE / DELETE を反映した
 *   新 PdfField[] を返す。
 *
 *   - INSERT（DB に無く client にあり）: 新規 PdfField を末尾追加 + 採番再確定。
 *   - UPDATE（両方にある name）: client の bbox / label / 属性で上書き。
 *   - DELETE（DB にあるが client に無い）: 結果から除外（new_fields 列から消える）。
 *
 *   templates `mergeFieldsSnapshot` は「templates.fields 全件」を扱うが、本関数は
 *   「minute.new_fields の差分」のみを扱う（templates fields は別経路 = page.tsx で
 *   mergeTemplateAndNewFields でマージされる）。判定ロジックは 1:1 同型。
 *
 * 採番再確定（templates `mergeFieldsSnapshot` L383-391 同方式）:
 *   - clientItem.name が templateFields の name 集合 / DB 既存 newField の確定 name と
 *     衝突する場合、サーバ側で次の空き `field_N` へ再採番。
 *   - 名前形式不正（snake_case 外 / >40 文字）でも採番再確定。
 *
 * 検証（templates 同型）:
 *   - 件数上限 FIELDS_MAX(20)（templates 同値・合算判定は呼出側の責務）
 *   - bbox 範囲（pageSizes で範囲チェック）
 *   - label 1-40 文字
 *
 * 並び順:
 *   - DB 既存 newField の出現順 → INSERT 新規 newField の出現順、で末尾追加。
 *   - これにより既存 newField の表示順が安定する（再オープンで同じ並び）。
 */
import { z } from 'zod'
import {
  PdfFieldBboxSchema,
  type PdfField,
  type PdfFieldBbox,
} from '@/lib/ai/schemas/pdf-field-schema'
import {
  buildPdfFieldFromDefaults,
  NEW_FIELD_DEFAULTS,
} from './bbox-save'
import { isBboxWithinPage, type PageMeta } from './bbox-coords'

const FIELDS_MAX = 20
const LABEL_MAX = 40
const NAME_REGEX = /^[a-z_][a-z0-9_]*$/

/**
 * クライアントから送られる newField スナップショット 1 件分。
 *
 * templates `FieldSnapshotItem` 同型のうち、newFields 専用に必要なものだけ抽出:
 *   - name: 楽観採番された field_N（衝突時はサーバで再採番）。
 *   - label: 表示ラベル（templates 同型・必須 1-40 文字）。
 *   - bbox: 位置とサイズ（templates 同型）。
 *   - multiline?: TemplateFieldDef の multiline を保持するため optional 追加。
 *   - isNew?: true=明示的に新規（INSERT 候補）。省略時は「name が DB にあれば UPDATE / 無ければ INSERT」で振り分ける。
 */
export const NewFieldSnapshotItemSchema = z.object({
  name: z.string().min(1),
  label: z.string(),
  bbox: PdfFieldBboxSchema,
  multiline: z.boolean().optional(),
  isNew: z.boolean().optional(),
})
export type NewFieldSnapshotItem = z.infer<typeof NewFieldSnapshotItemSchema>

export type MergeNewFieldsSnapshotError =
  | 'BBOX_OUT_OF_RANGE'
  | 'PAGE_NOT_FOUND'
  | 'INVALID_LABEL'
  | 'NAME_GEN_FAILED'
  | 'FIELD_COUNT_OUT_OF_RANGE'

export type MergeNewFieldsSnapshotResult =
  | { ok: true; newFields: PdfField[] }
  | { ok: false; error: MergeNewFieldsSnapshotError }

/** label が 1〜LABEL_MAX 文字か（前後空白は trim 後で判定・templates 同方式）。 */
function isValidLabel(label: string | undefined): label is string {
  if (typeof label !== 'string') return false
  const t = label.trim()
  return t.length >= 1 && t.length <= LABEL_MAX
}

/**
 * 空き連番 `field_N` を採番（used 集合と衝突しない最小の N）。
 * templates `nextFieldName` 同方式。FIELDS_MAX+1 まで試して見つからなければ null。
 */
function nextFieldName(used: Set<string>): string | null {
  for (let n = 1; n <= FIELDS_MAX + 1; n++) {
    const candidate = `field_${n}`
    if (!used.has(candidate)) return candidate
  }
  return null
}

/**
 * DB の現 new_fields (PdfField[]) と client snapshot を突き合わせ、UPDATE/INSERT/DELETE を
 * 反映した新 PdfField[] を返す。
 *
 * @param dbNewFields    DB の現 minute.new_fields（parseNewFields 通過済）
 * @param clientSnapshot AdjustView から来た現状の newField 全件（newFieldNames に含まれる）
 * @param templateNames  templates.fields の name 集合（newFields name と衝突しないよう used に入れる）
 * @param pageSizes      bbox 範囲チェック用
 */
export function mergeNewFieldsSnapshot(
  dbNewFields: PdfField[],
  clientSnapshot: NewFieldSnapshotItem[],
  templateNames: ReadonlySet<string>,
  pageSizes: PageMeta[],
): MergeNewFieldsSnapshotResult {
  const pageByNum = new Map(pageSizes.map((p) => [p.page, p]))

  // bbox 範囲チェック（templates `checkBbox` 同方式）。
  function checkBbox(bbox: PdfFieldBbox): MergeNewFieldsSnapshotError | null {
    const meta = pageByNum.get(bbox.page)
    if (!meta) return 'PAGE_NOT_FOUND'
    if (!isBboxWithinPage(bbox, meta)) return 'BBOX_OUT_OF_RANGE'
    return null
  }

  // DB 既存の newField name 集合（UPDATE 判定用）。
  const dbNewNames = new Set(dbNewFields.map((f) => f.name))

  // 採番用 used 集合: templates fields + DB 既存 newField + これから確定する INSERT name。
  // templates fields との衝突は「採番再確定」、DB 既存 newField との衝突は「UPDATE 扱い」になるよう
  // 後段で振り分けるため、ここでは templates のみ used に積む（DB 既存は別経路）。
  const used = new Set<string>(templateNames)
  // DB 既存 newField の name は UPDATE で再利用するため used に積んでおく（INSERT 採番が衝突しないように）。
  for (const f of dbNewFields) used.add(f.name)

  // クライアントから来た item を UPDATE / INSERT に振り分け（templates `mergeFieldsSnapshot` L308-319 同方式）。
  const updateByName = new Map<string, NewFieldSnapshotItem>()
  const inserts: NewFieldSnapshotItem[] = []
  for (const item of clientSnapshot) {
    const isExisting = !item.isNew && dbNewNames.has(item.name)
    if (isExisting) {
      updateByName.set(item.name, item)
    } else {
      inserts.push(item)
    }
  }

  // 1) DB 既存 newField を出現順で反映（UPDATE / DELETE 判定）。
  //    - UPDATE: client から bbox / label / multiline で差替（type / max_chars / font / padding は DB 値温存）
  //    - DELETE: client snapshot に無い既存 newField は除外
  const merged: PdfField[] = []
  for (const f of dbNewFields) {
    const upd = updateByName.get(f.name)
    if (!upd) {
      // DELETE: client snapshot に無い → 結果から除外（templates 同方式）。
      continue
    }
    const bboxErr = checkBbox(upd.bbox)
    if (bboxErr) return { ok: false, error: bboxErr }
    if (!isValidLabel(upd.label)) return { ok: false, error: 'INVALID_LABEL' }
    merged.push({
      ...f,
      bbox: upd.bbox,
      label: upd.label.trim(),
      multiline: upd.multiline ?? f.multiline ?? false,
    })
  }

  // 2) INSERT を末尾追加（属性は NEW_FIELD_DEFAULTS で補完 + 採番再確定）。
  for (const item of inserts) {
    const bboxErr = checkBbox(item.bbox)
    if (bboxErr) return { ok: false, error: bboxErr }
    if (!isValidLabel(item.label)) return { ok: false, error: 'INVALID_LABEL' }

    // name 採番: クライアント楽観 name が形式 OK かつ未使用ならそのまま、
    // 衝突 or 形式不正ならサーバで次の空き field_N へ再採番（templates 同方式）。
    let name = item.name
    const validForm = NAME_REGEX.test(name) && name.length <= 40
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
        multiline: item.multiline ?? NEW_FIELD_DEFAULTS.multiline,
      }),
    )
  }

  // 3) 件数ガード（templates 同方式・new_fields 単独で 20 件上限）。
  //    templates fields との合算判定は呼出側の責務（テンプレ + new_fields が合算 20 件以内）。
  if (merged.length > FIELDS_MAX) {
    return { ok: false, error: 'FIELD_COUNT_OUT_OF_RANGE' }
  }

  return { ok: true, newFields: merged }
}
