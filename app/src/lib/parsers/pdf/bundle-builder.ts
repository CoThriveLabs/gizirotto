/**
 * TemplateBundleBuilder（設計書 v1.4.2 §3-8）。
 *
 * Phase 2.5 完了時点で以下 3 点セットを組み立てて保存する責務を持つ:
 *   1. templates_processed/{family_id}/{template_id}_blank.pdf
 *      - パス A: 原本そのまま（編集ツール透かしも原本のまま残る、§3-9 案 B 厳守）
 *      - パス B: ユーザー指定領域のみ白塗りした PDF
 *   2. templates.fields JSONB (PdfField[] 形式、編集ツール透かし bbox 除外済)
 *   3. templates.license_consent JSONB ({user_id, agreed_at})
 *
 * 本ファイルは「3 点セットを組み立てる純粋関数」+「Supabase Storage / DB に
 * 渡せる shape に正規化する」役割のみ担当。
 * 実際の I/O（Storage upload + DB INSERT）は Route Handler 層（Week 4-5 で実装する
 * /api/templates/pdf/* 系）が担当する。本ファイルは I/O 非依存で unit test 可能。
 *
 * 重要:
 *   パス A 経路では `bytesFor_blank_pdf` は入力 PDF と **完全一致**（無加工コピー）。
 *   バイト単位比較で原本 = blank_pdf となること。
 */

import type { PdfField } from '../../ai/schemas/pdf-field-schema'
import type { WhiteoutBox } from './whiteout-pipeline'

/**
 * テンプレ登録 API への入力（解析 API 出力相当）。
 */
export interface TemplateBundleInput {
  /** アップロードされた原本 PDF バイト列 */
  originalPdfBytes: Uint8Array
  /** ユーザー UI で選択した入力経路 */
  inputPathType: 'A' | 'B'
  /** パス B のとき、ユーザー UI 確定済の白塗り矩形（applyWhiteout の入力） */
  whiteoutBoxes?: WhiteoutBox[]
  /** FieldSemanticExtractor 出力（編集ツール透かしは既に除外済） */
  fields: PdfField[]
  /** 著作権予防策の同意情報 */
  licenseConsent: {
    user_id: string
    agreed_at: string // ISO8601 timestamp
  }
  /** Storage 保存パス組み立て用 */
  familyId: string
  templateId: string
}

/**
 * 3 点セットの組み立て結果。
 * 呼び出し側はこれを Storage upload + DB INSERT に展開する。
 */
export interface TemplateBundle {
  /** Storage パス: templates_processed/{family_id}/{template_id}_blank.pdf */
  blankPdfPath: string
  /** Storage に upload する blank PDF バイト列 */
  blankPdfBytes: Uint8Array
  /** DB INSERT 用の Json columns */
  dbColumns: {
    /** background_pdf_path */
    background_pdf_path: string
    /** input_path_type（'A' | 'B'） */
    input_path_type: 'A' | 'B'
    /** fields JSONB */
    fields: PdfField[]
    /** license_consent JSONB */
    license_consent: { user_id: string; agreed_at: string }
  }
}

/**
 * 3 点セットを組み立てる。実際の I/O は行わず、Supabase に渡せる shape に
 * 正規化するのみ。
 *
 * 内部処理:
 *   - パス A: blankPdfBytes = originalPdfBytes（無加工コピー厳守）
 *   - パス B: blankPdfBytes = applyWhiteout(originalPdfBytes, whiteoutBoxes)
 *   - dbColumns: DB カラムに揃える
 */
export async function buildTemplateBundle(
  input: TemplateBundleInput,
): Promise<TemplateBundle> {
  validateInput(input)

  // 1. blank PDF バイト列を確定
  let blankPdfBytes: Uint8Array
  if (input.inputPathType === 'A') {
    // パス A: 無加工コピー（編集ツール透かしも原本のまま、§3-9 案 B 厳守）
    // 新しい Uint8Array を作って参照分離（呼び出し側で原本を変更しても安全）
    blankPdfBytes = new Uint8Array(input.originalPdfBytes)
  } else {
    // パス B: ユーザー確定済矩形で白塗り
    if (!input.whiteoutBoxes || input.whiteoutBoxes.length === 0) {
      // 0 個指定の場合も無加工コピーで進める（UI 上は 0 確定はあり得ないが防御）
      blankPdfBytes = new Uint8Array(input.originalPdfBytes)
    } else {
      const { applyWhiteout } = await import('./whiteout-pipeline')
      blankPdfBytes = await applyWhiteout(input.originalPdfBytes, input.whiteoutBoxes)
    }
  }

  // 2. Storage パス組み立て
  const blankPdfPath = `${input.familyId}/${input.templateId}_blank.pdf`

  // 3. DB columns 正規化
  return {
    blankPdfPath,
    blankPdfBytes,
    dbColumns: {
      background_pdf_path: blankPdfPath,
      input_path_type: input.inputPathType,
      fields: input.fields,
      license_consent: input.licenseConsent,
    },
  }
}

function validateInput(input: TemplateBundleInput): void {
  if (!input.originalPdfBytes || input.originalPdfBytes.byteLength === 0) {
    throw new Error('TEMPLATE_BUNDLE_EMPTY_PDF')
  }
  if (input.inputPathType !== 'A' && input.inputPathType !== 'B') {
    throw new Error('TEMPLATE_BUNDLE_INVALID_PATH_TYPE')
  }
  if (!input.fields || input.fields.length === 0) {
    throw new Error('TEMPLATE_BUNDLE_EMPTY_FIELDS')
  }
  if (!input.licenseConsent?.user_id || !input.licenseConsent?.agreed_at) {
    throw new Error('TEMPLATE_BUNDLE_LICENSE_CONSENT_REQUIRED')
  }
  if (!input.familyId || !input.templateId) {
    throw new Error('TEMPLATE_BUNDLE_MISSING_IDS')
  }
}
