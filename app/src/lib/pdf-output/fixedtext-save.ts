/**
 * 固定テキスト保存の純粋ロジック。
 *
 * Server Action（updateTemplateFixedTexts）から DB I/O を分離した純関数群。
 * unit テスト可能にするため Supabase 非依存で「クライアント送付 FixedText[]」を検証し
 * 「保存すべき fixed_texts 配列」を組み立てる。
 *
 * 設計の核（§3-6）:
 *   - value: 1〜FIXEDTEXT_VALUE_MAX 字。空（trim 後）は保存対象から除外（作らない）。
 *   - bbox: isBboxWithinPage でページ範囲内チェック（bbox-coords 既存流用）。
 *   - 件数上限: fields の FIELDS_MAX=20 に倣い 20。
 *   - fields / whiteout_boxes には触れない（カラム独立保存・fieldsVersion 非発火）。
 */
import { z } from 'zod'
import { PdfFieldBboxSchema } from '@/lib/ai/schemas/pdf-field-schema'
import { isBboxWithinPage, type PageMeta } from './bbox-coords'
import type { FixedText } from './fixedtext-adapter'
import { DEFAULT_FIXEDTEXT_FONT, fixedTextFieldName } from './fixedtext-adapter'

/** value の最大文字数（初版 max_chars 相当・§3-6 既定 100）。 */
export const FIXEDTEXT_VALUE_MAX = 100

/** 固定テキストの件数上限（fields FIELDS_MAX に倣い 20・§3-6）。 */
export const FIXEDTEXT_MAX = 20

/** font スキーマ（family 任意・size 正数。欠損時はサーバ既定で補完）。 */
const FixedTextFontSchema = z.object({
  family: z.string().min(1),
  size: z.number().positive(),
})

/**
 * クライアントから受け取る 1 固定テキスト（§3-6）。
 * name はクライアント楽観採番（ft_N）。サーバで index ベースに安定再採番する。
 * value は空も受理（trim 後に空なら後段で除外）。font は欠損可（既定補完）。
 */
export const FixedTextItemSchema = z.object({
  name: z.string().min(1),
  value: z.string().max(FIXEDTEXT_VALUE_MAX),
  bbox: PdfFieldBboxSchema,
  font: FixedTextFontSchema.optional(),
})
export type FixedTextItem = z.infer<typeof FixedTextItemSchema>

/** 保存ペイロード（空配列も許容＝全削除）。最大は除外前の生件数で 100 まで緩く受け、後段で除外＋20上限。 */
export const FixedTextsPayloadSchema = z.array(FixedTextItemSchema).max(100)

/** zod 互換の単一スキーマエイリアス（設計書命名 FixedTextSchema）。 */
export const FixedTextSchema = FixedTextItemSchema

export type FixedTextSaveError =
  | 'BBOX_OUT_OF_RANGE'
  | 'PAGE_NOT_FOUND'
  | 'FIXEDTEXT_COUNT_OUT_OF_RANGE'

export type BuildFixedTextsResult =
  | { ok: true; fixedTexts: FixedText[] }
  | { ok: false; error: FixedTextSaveError }

/**
 * クライアント送付の固定テキスト群を検証し、保存すべき FixedText[] を組む（§3-6）。
 *
 * - value が空（trim 後）の要素は除外（空の固定テキストは作らない）。
 * - 残った各要素の bbox を pageSizes で範囲チェック（PAGE_NOT_FOUND / BBOX_OUT_OF_RANGE）。
 * - name は出現順で ft_1.. に安定再採番（クライアント楽観 name は信用しない）。
 * - font は欠損なら DEFAULT_FIXEDTEXT_FONT で補完。
 * - 除外後の件数が FIXEDTEXT_MAX 超なら FIXEDTEXT_COUNT_OUT_OF_RANGE。
 *
 * Supabase 非依存の純関数。fields / whiteout_boxes には一切触れない。
 */
export function buildFixedTexts(
  items: FixedTextItem[],
  pageSizes: PageMeta[],
): BuildFixedTextsResult {
  const pageByNum = new Map(pageSizes.map((p) => [p.page, p]))

  // 空 value を除外（§3-6）。残った順序で安定採番する。
  const kept = items.filter((it) => it.value.trim() !== '')

  if (kept.length > FIXEDTEXT_MAX) {
    return { ok: false, error: 'FIXEDTEXT_COUNT_OUT_OF_RANGE' }
  }

  const fixedTexts: FixedText[] = []
  for (let i = 0; i < kept.length; i++) {
    const it = kept[i]
    const meta = pageByNum.get(it.bbox.page)
    if (!meta) return { ok: false, error: 'PAGE_NOT_FOUND' }
    if (!isBboxWithinPage(it.bbox, meta)) {
      return { ok: false, error: 'BBOX_OUT_OF_RANGE' }
    }
    fixedTexts.push({
      name: fixedTextFieldName(i),
      value: it.value,
      bbox: {
        page: it.bbox.page,
        x: it.bbox.x,
        y: it.bbox.y,
        w: it.bbox.w,
        h: it.bbox.h,
      },
      font: it.font ?? { ...DEFAULT_FIXEDTEXT_FONT },
    })
  }

  return { ok: true, fixedTexts }
}
