import { createSupabaseServerClient } from '@/lib/supabase/server'
import { renderMinuteRawWithOverlayToImages } from '@/lib/pdf-output/image-render-raw-overlay'
import { type MinuteOverlayField } from '@/lib/pdf-output/image-render-overlay-shared'
import type { WhiteoutBox } from '@/lib/parsers/pdf/whiteout-pipeline'
import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'
import { fixedTextToPseudoFieldsByLines } from '@/lib/pdf-output/regenerate-minute-pdf'
import {
  buildOverlayFieldsForRender,
} from '@/lib/pdf-output/render-image-overlay-filter'
import { readUniformOverridePt } from '@/lib/pdf-output/uniform-override'
import { parseFieldOverrides } from '@/lib/pdf-output/field-override'
import { errorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import type { TplRow, RenderSourceResult } from './render-source-types'
import { normalizeFixedTexts, applyBboxOverrides } from './render-image-helpers'

export interface RawOverlayRenderParams {
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>
  template: TplRow
  tplFields: PdfField[]
  values: Record<string, unknown>
  bboxOverrides: unknown
  pageRange: { from: number; to: number } | undefined
  dpi: number
  format: 'png' | 'jpeg'
  asZip: boolean
  raw: boolean
  rawExceptSelected: string | undefined
}

// 案 A: raw 起点で純画像合成（A500 を構造的に回避）。
export async function resolveRawOverlayRender(
  params: RawOverlayRenderParams,
): Promise<RenderSourceResult> {
  const {
    supabase,
    template,
    tplFields,
    values,
    bboxOverrides,
    pageRange,
    dpi,
    format,
    asZip,
    raw,
    rawExceptSelected,
  } = params

  const { data: rawBlob, error: rawDlErr } = await supabase.storage
    .from('templates_raw')
    .download(template.source_path as string)
  if (rawDlErr || !rawBlob) {
    return { ok: false, response: NextResponse.json({ error: 'PDF_DOWNLOAD_FAILED' }, { status: 500 }) }
  }
  const rawBytes = new Uint8Array(await rawBlob.arrayBuffer())

  const whiteoutBoxes = Array.isArray(template.whiteout_boxes)
    ? (template.whiteout_boxes as unknown as WhiteoutBox[])
    : []
  const fixedTexts = normalizeFixedTexts(template.fixed_texts)
  const effectiveFields = applyBboxOverrides(tplFields, bboxOverrides)

  // overlay-generator 経路と同じ「fixed text を疑似 PdfField 化」でフラット化する
  // （2026-06-14 改訂：行展開廃止・元 ft.bbox 保持・改行分割は下流 layoutFixedTextLines が担う）。
  // フィッティング・座標規約は共通。
  //
  // raw=true は記入値ゼロ背景を返すため、effectiveFields の値を一切 overlayFields に積まない
  // （白塗り・固定テキスト・テンプレ自身のラベルだけ残る）。
  // AdjustView は本背景の上にクライアント canvas で記入値を都度合成する。
  //
  // raw=true かつ raw_except_selected 指定時は指定 field 1 つだけスキップし、他 field は
  // 通常どおり overlay に積む（「selected 以外は焼き込み済 PNG」+「selected は canvas 合成」）。
  //
  // 選別ロジックは buildOverlayFieldsForRender（pure・unit test 3 ケース回帰）に集約。
  const overlayFields: MinuteOverlayField[] = buildOverlayFieldsForRender(
    effectiveFields,
    values,
    raw,
    rawExceptSelected,
  )
  // 固定テキスト WYSIWYG: 固定テキスト疑似 field 名を集め、image-renderer 内で fitTextInBox を
  //   通さず共有純関数で top 揃え直描きさせる（サムネ・編集 canvas と同一式＝WYSIWYG）。
  //   PDF 出力（overlay-generator）と一致。
  const fixedTextNames = new Set<string>()
  for (const ft of fixedTexts) {
    const lineFields = fixedTextToPseudoFieldsByLines(ft)
    for (const lf of lineFields) {
      overlayFields.push({ field: lf.field, value: lf.value })
      fixedTextNames.add(lf.field.name)
    }
  }

  // 記入欄 field（effective）のみを uniform 対象に。固定テキスト疑似 field はテンプレ固有
  //   サイズを保つため除外する。regenerate-minute-pdf.ts と同一の母集団・同一
  //   computeUniformFontSize を通すことで、PDF 出力と詳細プレビュー画像の uniform を一致させる。
  const uniformTargetNames = new Set(effectiveFields.map((f) => f.name))

  // 全体の文字サイズ手動上書き:
  //   bbox_overrides jsonb の予約キー `__uniform__` を読み取り、非 null なら snap を含む
  //   自動算出をスキップして本値を採用する。PDF 出力（overlay-generator）と一致させる。
  const uniformOverridePt =
    readUniformOverridePt(parseFieldOverrides(bboxOverrides)) ?? undefined

  try {
    const result = await renderMinuteRawWithOverlayToImages({
      rawPdfBytes: rawBytes,
      whiteoutBoxes,
      overlayFields,
      pageRange,
      requestedDpi: dpi,
      format,
      asZip,
      uniformTargetNames,
      fixedTextNames,
      uniformOverridePt,
    })
    return { ok: true, result }
  } catch (err) {
    return { ok: false, response: errorResponse('IMAGE_RENDER_FAILED', 500, err) }
  }
}
