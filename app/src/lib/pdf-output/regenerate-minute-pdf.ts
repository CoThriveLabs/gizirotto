import type { SupabaseClient } from '@supabase/supabase-js'
import { generateOverlayPdf } from './overlay-generator'
import { generateSimplePdf } from './simple-pdf-generator'
import {
  generateMinuteThumbnail,
  markMinuteThumbnailFailed,
} from './minute-thumbnail'
import { flattenContent } from '../utils/minutes-output'
import type { PdfField } from '../ai/schemas/pdf-field-schema'
import type { FixedText } from './fixedtext-adapter'
import {
  applyBboxOverrides as applyFieldOverridesPure,
  parseFieldOverrides,
} from './field-override'
import { fixedTextToPseudoFieldsByLines } from './fixed-text-pseudo-field'
// Re-export for back-compat: render-image/route.ts は本モジュールから import している。
// 共有純関数は fixed-text-pseudo-field.ts に集約（minute-thumbnail.ts との循環 import 回避）。
export { fixedTextToPseudoFieldsByLines } from './fixed-text-pseudo-field'
import { readUniformOverridePt } from './uniform-override'
import {
  mergeTemplateAndNewFields,
  parseNewFields,
} from './merge-template-and-new-fields'

/**
 * 議事録の PDF を生成して `minutes_output/{family_id}/{id}.pdf` に upsert し、
 * `minutes.output_pdf_path` を更新する。
 *
 * 経路:
 *   - 全 field に bbox + background_pdf_path + blank_pdf_status='ready' 揃ってる → overlay 経路（テンプレ重ね）
 *   - 上記いずれか欠ける → simple-pdf-generator fallback（bbox 欠落テンプレでも text-only PDF を
 *     生成し詳細ページに placeholder を表示させない）。
 *
 * 失敗は呼び出し側に伝播させず（議事録 CRUD 自体は成功させる）、結果を返す。
 */
export type RegenerateMinutePdfResult =
  | { ok: true; outputPath: string }
  | { ok: false; reason: string }

export async function regenerateMinutePdf(
  supabase: SupabaseClient,
  minuteId: string,
): Promise<RegenerateMinutePdfResult> {
  try {
    const { data: minute, error: mErr } = await supabase
      .from('minutes')
      .select('id, family_id, template_id, title, content_json, bbox_overrides, new_fields')
      .eq('id', minuteId)
      .maybeSingle()
    if (mErr || !minute || !minute.template_id) {
      // minute レコード自体取れていない（or template_id 未設定）→
      // 更新対象 ID が確定できないため markFailed は呼ばない。
      return { ok: false, reason: 'MINUTE_NOT_FOUND' }
    }

    const { data: tpl, error: tErr } = await supabase
      .from('templates')
      .select('name, background_pdf_path, blank_pdf_status, fields, fixed_texts')
      .eq('id', minute.template_id)
      .maybeSingle()
    if (tErr || !tpl) {
      // pending 据え置き根絶のため failed 遷移してから return。
      await markMinuteThumbnailFailed(supabase, minute.id)
      return { ok: false, reason: 'TEMPLATE_NOT_FOUND' }
    }

    const tplFields = normalizeFields(tpl.fields)
    // minute 固有の追加 field を末尾合流。
    //   - 既存 minute（new_fields = [] / null）の場合は templates fields をそのまま返す（不変）。
    //   - name 衝突時は templates 優先・newFields 側を `field_N` 再採番。
    const fields = mergeTemplateAndNewFields(
      tplFields,
      parseNewFields(minute.new_fields),
    )
    const values = flattenContent(minute.content_json)
    const hasAllBbox =
      fields.length > 0 &&
      fields.every(
        (f) =>
          !!f.bbox &&
          typeof (f.bbox as { page?: unknown }).page === 'number',
      )
    const overlayReady =
      hasAllBbox &&
      !!tpl.background_pdf_path &&
      tpl.blank_pdf_status === 'ready'

    let pdfBytes: Uint8Array
    if (overlayReady) {
      const { data: blob, error: dlErr } = await supabase.storage
        .from('templates_processed')
        .download(tpl.background_pdf_path as string)
      if (dlErr || !blob) {
        // pending 据え置き根絶。
        await markMinuteThumbnailFailed(supabase, minute.id)
        return { ok: false, reason: 'BLANK_PDF_DOWNLOAD_FAILED' }
      }
      const blankBytes = new Uint8Array(await blob.arrayBuffer())
      const effective = applyBboxOverrides(fields, minute.bbox_overrides)
      // 固定テキスト: fixed_texts を「常時値あり field」として overlay へ合流。
      //   1. 疑似 PdfField 化（font は FixedText.font 優先・欠損のみ NEW_FIELD_DEFAULTS 補完）。
      //   2. fieldValues[ft.name] = ft.value を注入し、通常 field と同様に fitText→drawText させる。
      //   白塗りの上に drawText で乗る（背景→白塗り焼込→drawText の順・特別な順序制御不要）。
      //   ※ Word 出力は対象外（初版は overlay 経路のみ）。
      const fixedTexts = normalizeFixedTexts(tpl.fixed_texts)
      // 固定テキスト疑似 PdfField 化（2026-06-14 改訂・bbox 内 縦横中央配置対応）:
      //   `fixedTextToPseudoFieldsByLines` は常に長さ 0 or 1 の配列を返す（行展開は廃止）。
      //   `\n` 分割は下流の `layoutFixedTextLines` が担い、元 ft.bbox（h 含む）を保持する。
      //   これにより overlay-generator の isFixedText 分岐で縦中央計算に bbox.h を使える。
      const fixedFields: PdfField[] = []
      const fixedValues: Record<string, string> = {}
      for (const ft of fixedTexts) {
        const lineFields = fixedTextToPseudoFieldsByLines(ft)
        for (const lf of lineFields) {
          fixedFields.push(lf.field)
          fixedValues[lf.field.name] = lf.value
        }
      }
      // 記入欄 field（effective）のみを uniform 対象に。固定テキスト疑似 field（fixedFields）は
      //   テンプレ固有サイズを保つため除外する。overlay-generator 内で母集団 = この集合に属する
      //   field のみとして統一サイズを算出する。
      const uniformTargetNames = new Set(effective.map((f) => f.name))
      // 固定テキスト疑似 field 名を集め、overlay-generator 内で fitTextInBox を通さず共有純関数で
      //   top 揃え直描きさせる（サムネ・編集 canvas と同一式＝WYSIWYG）。
      const fixedTextNames = new Set(fixedFields.map((f) => f.name))
      // 全体の文字サイズ手動上書き: bbox_overrides jsonb の予約キー `__uniform__` から手動値を取り出す。
      //   非 null なら snap を含む自動算出をスキップして本値を採用する（手動 > 自動）。
      const uniformOverridePt =
        readUniformOverridePt(parseFieldOverrides(minute.bbox_overrides)) ?? undefined
      const overlay = await generateOverlayPdf({
        blankPdfBytes: blankBytes,
        fields: [...effective, ...fixedFields],
        fieldValues: { ...values, ...fixedValues },
        uniformTargetNames,
        fixedTextNames,
        uniformOverridePt,
      })
      pdfBytes = overlay.pdfBytes
    } else {
      // bbox 欠落 / blank_pdf 未準備テンプレ向け text-only fallback
      const items =
        fields.length > 0
          ? fields.map((f) => ({
              label: ((f as { label?: unknown }).label as string) ?? f.name,
              value: values[f.name] ?? '',
            }))
          : Object.entries(values).map(([k, v]) => ({
              label: k,
              value: String(v),
            }))
      if (items.length === 0) {
        // pending 据え置き根絶。
        await markMinuteThumbnailFailed(supabase, minute.id)
        return { ok: false, reason: 'NO_CONTENT' }
      }
      pdfBytes = await generateSimplePdf({
        title: (minute.title as string | null) ?? (tpl.name as string | null) ?? undefined,
        items,
      })
    }

    const outputPath = `${minute.family_id}/${minute.id}.pdf`
    const outBlob = new Blob([pdfBytes.slice().buffer], { type: 'application/pdf' })
    const { error: upErr } = await supabase.storage
      .from('minutes_output')
      .upload(outputPath, outBlob, {
        contentType: 'application/pdf',
        upsert: true,
      })
    if (upErr) {
      // pending 据え置き根絶。
      await markMinuteThumbnailFailed(supabase, minute.id)
      return { ok: false, reason: 'UPLOAD_FAILED' }
    }
    await supabase
      .from('minutes')
      .update({ output_pdf_path: outputPath })
      .eq('id', minute.id)

    // 既知 cache キー（render-image route が生成する dpi/format 組合せ）だけピンポイント削除。
    // 全件 list → remove は他議事録の cache も巻添リスク + page=1..N 並行呼出時の競合源。
    const knownCacheKeys = [
      `${minute.family_id}/minutes/${minute.id}_72_png.png`,
      `${minute.family_id}/minutes/${minute.id}_150_png.png`,
      `${minute.family_id}/minutes/${minute.id}_300_png.png`,
      `${minute.family_id}/minutes/${minute.id}_150_png.zip`,
      `${minute.family_id}/minutes/${minute.id}_300_png.zip`,
    ]
    await supabase.storage.from('image_cache').remove(knownCacheKeys)

    // dpi 72 サムネ生成。共通ヘルパ generateMinuteThumbnail に集約（内部経路は raw 起点
    // = renderMinuteRawWithOverlayToImages のため pdfBytes は渡さない）。
    // 本関数の戻り値は ok を維持する（サムネ失敗で minutes CRUD 自体は落とさない）。
    await generateMinuteThumbnail(supabase, {
      minuteId: minute.id as string,
    })

    return { ok: true, outputPath }
  } catch (err) {
    // 最外 catch でも pending 据え置きを根絶。
    // 到達は大半が後段なので minuteId（関数引数・確実に有り）で update を試す。
    // try-catch で囲んで外側 catch 内のさらなる throw を防ぐ。
    try {
      await markMinuteThumbnailFailed(supabase, minuteId)
    } catch {
      /* noop: 失敗してもこれ以上できることはない */
    }
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'UNKNOWN',
    }
  }
}

function normalizeFields(raw: unknown): PdfField[] {
  if (!raw) return []
  const arr: unknown = Array.isArray(raw)
    ? raw
    : typeof raw === 'object'
      ? (raw as { fields?: unknown }).fields
      : null
  if (!Array.isArray(arr)) return []
  return arr.filter(
    (f): f is PdfField =>
      !!f &&
      typeof f === 'object' &&
      typeof (f as { name?: unknown }).name === 'string',
  ) as PdfField[]
}

/**
 * templates.fixed_texts（jsonb）を FixedText[] に正規化。
 * null / 旧テンプレ / 不正要素はフィルタして空配列にフォールバック（従来出力を保つ）。
 */
function normalizeFixedTexts(raw: unknown): FixedText[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (ft): ft is FixedText =>
      !!ft &&
      typeof ft === 'object' &&
      typeof (ft as { name?: unknown }).name === 'string' &&
      typeof (ft as { value?: unknown }).value === 'string' &&
      !!(ft as { bbox?: unknown }).bbox &&
      typeof (ft as { bbox: { page?: unknown } }).bbox.page === 'number',
  )
}

/**
 * partial 化に伴い純関数 `applyFieldOverridesPure`（field-override.ts）へ委譲する。
 * 後方互換ルール（旧 `{x,y}` のみ override も partial）と fontSize 反映（per-field 上書き）を両立。
 */
function applyBboxOverrides(fields: PdfField[], overrides: unknown): PdfField[] {
  return applyFieldOverridesPure(fields, overrides)
}
