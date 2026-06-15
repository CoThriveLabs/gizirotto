/**
 * mergeTemplateAndNewFields — templates fields と minute 固有 newFields の合流純関数。
 *
 * 設計書 minutes_adjust_editor_renewal_design_2026-06-08.md §9 段階 2.5a 準拠。
 * サーバ専用 import 一切なし（クライアント・サーバ共有可）。
 *
 * 役割:
 *   AdjustView「項目を追加」機能で minute ごとに付与した新規 field（PdfField[]）を、
 *   テンプレ fields に「末尾追加」する形で 1 本の PdfField[] にまとめる。
 *   regenerate-minute-pdf / render-image / adjust/page の 3 経路から呼ぶ共通入口。
 *
 * 衝突解決:
 *   - name 衝突時は **templates 側を優先**（newFields 同 name は採番再確定する）。
 *   - 再採番は `field_N` 楽観方式（bbox-save.ts `mergeFieldsSnapshot` と同型）。
 *   - 名前が形式不正（snake_case 外 / >40 文字）でも採番再確定する（安全側）。
 *
 * 並び順:
 *   - templates fields → newFields の末尾追加。順序維持で WYSIWYG を壊さない。
 *
 * 後方互換:
 *   - newFields = null / undefined / 空配列 → templates fields をそのまま返す（参照同一性は新規配列）。
 *   - newFields の要素が破損（name 無し等）→ その要素はスキップ（他要素は処理続行）。
 */
import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'

const FIELDS_MAX = 20
const NAME_REGEX = /^[a-z_][a-z0-9_]*$/

/**
 * `field_N` の最小の空き連番を採番（used 集合と衝突しない最小の N）。
 *
 * 上限到達時は null。bbox-save.ts `nextFieldName` と同方式（templates 1:1 互換）。
 */
function nextFieldName(used: Set<string>): string | null {
  for (let n = 1; n <= FIELDS_MAX + 1; n++) {
    const candidate = `field_${n}`
    if (!used.has(candidate)) return candidate
  }
  return null
}

/**
 * templates fields と newFields を統合した PdfField[] を返す。
 *
 * @param templateFields テンプレ fields（applyBboxOverrides 適用前 / 後どちらでも可）
 * @param newFields      minute.new_fields jsonb から復元した PdfField[]（null/undefined 可）
 * @returns 並び順は [...templates, ...採番再確定済 newFields]
 */
export function mergeTemplateAndNewFields(
  templateFields: PdfField[],
  newFields: PdfField[] | null | undefined,
): PdfField[] {
  if (!newFields || newFields.length === 0) {
    return [...templateFields]
  }

  // used: templates fields の name 全件 + これから確定する newFields の name。
  const used = new Set<string>()
  for (const f of templateFields) {
    if (f && typeof f.name === 'string') used.add(f.name)
  }

  const out: PdfField[] = [...templateFields]
  for (const nf of newFields) {
    if (!nf || typeof nf.name !== 'string') continue
    // 衝突 or 形式不正なら採番再確定。templates 側は不変・newFields 側だけ採番。
    let name = nf.name
    const validForm = NAME_REGEX.test(name) && name.length <= 40
    if (!validForm || used.has(name)) {
      const gen = nextFieldName(used)
      if (!gen) {
        // 上限到達: 既に 21+ field がある状態（通常起きない・防御）。以降の newFields は捨てる。
        break
      }
      name = gen
    }
    used.add(name)
    out.push({ ...nf, name })
  }
  return out
}

/**
 * `minutes.new_fields` jsonb 値から PdfField[] を取り出す（破損要素はスキップ）。
 *
 * regenerate-minute-pdf / render-image route から呼ぶための薄い正規化ヘルパ。
 * null / 非配列 / 配列内の壊れた要素はフィルタして空配列にフォールバックする。
 *
 * PdfField の全プロパティ厳密検証は呼出側で必要ならやる（ここは「name + bbox.page だけ最低
 * 担保」する寛容版・mergeTemplateAndNewFields 側で再採番するため name 形式不正も通す）。
 */
export function parseNewFields(raw: unknown): PdfField[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (f): f is PdfField =>
      !!f &&
      typeof f === 'object' &&
      typeof (f as { name?: unknown }).name === 'string' &&
      !!(f as { bbox?: unknown }).bbox &&
      typeof (f as { bbox: { page?: unknown } }).bbox.page === 'number',
  ) as PdfField[]
}
