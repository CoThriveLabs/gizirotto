/**
 * 議事録サムネ生成の共通ヘルパー。
 *
 * `renderMinuteRawWithOverlayToImages`（image-renderer.ts・raw 起点・1 段保存経路）を
 * 1 ページ限定 + DPI72 で流用する。output_pdf_path を経由しないため、output_pdf_path null
 * の旧議事録でも raw + テンプレ情報があればサムネを救済可能。
 *
 * 個人情報死守契約:
 *   `compositeWhiteoutOnPng` / drawText 合成のいずれかが失敗すれば throw → catch で
 *   markFailed → コード返却。素 raw PNG は一切出力しない。
 *
 * pending ループ防止:
 *   render 例外 / upload 失敗 → `markMinuteThumbnailFailed` で status='failed' 遷移。
 *   pending 据え置きを根絶し、on-demand 自動 trigger 対象から外す。
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { renderMinuteRawWithOverlayToImages } from './image-render-raw-overlay'
import { renderMinuteBuiltinBgWithOverlayToImages } from './image-renderer'
import { type MinuteOverlayField } from './image-render-overlay-shared'
import type { WhiteoutBox } from '@/lib/parsers/pdf/whiteout-pipeline'
import type { PdfField } from '../ai/schemas/pdf-field-schema'
import type { FixedText } from './fixedtext-adapter'
import { flattenContent } from '../utils/minutes-output'
import {
  applyBboxOverrides as applyFieldOverridesPure,
  parseFieldOverrides,
} from './field-override'
import { readUniformOverridePt } from './uniform-override'
import { buildBuiltinEffectiveFields } from './builtin-overlay-resolver'
import {
  mergeTemplateAndNewFields,
  parseNewFields,
} from './merge-template-and-new-fields'
import { fixedTextToPseudoFieldsByLines } from './fixed-text-pseudo-field'
import {
  loadBuiltinBackgroundPng,
  loadBuiltinThumbnailPng,
  loadBuiltinBboxOverrides,
  loadBuiltinPagePtSize,
  resolveBuiltinBboxSlugFromProcessedPath,
} from '@/lib/builtin-bbox-loader'

/** サムネ生成パラメータ（render-image route と同値）。 */
export const THUMB_DPI = 72
export const THUMB_FORMAT = 'png' as const

export type MinuteThumbResult =
  | { ok: true; thumbnailPath: string }
  | { ok: false; code: string }

/**
 * pdfBytes は受け取らず minuteId のみで内部で raw + templates 情報を取得する。
 */
interface GenerateMinuteThumbnailInput {
  minuteId: string
}

/**
 * 議事録の raw PDF + overlay fields から 1 ページ目サムネ画像を生成し
 * image_cache に保存、minutes.thumbnail_path / thumbnail_status を更新する。
 *
 * 内部例外は握り潰し 'failed' を DB に記録する（pending 据え置き根絶）。
 */
export async function generateMinuteThumbnail(
  supabase: SupabaseClient,
  { minuteId }: GenerateMinuteThumbnailInput,
): Promise<MinuteThumbResult> {
  try {
    // 1. minutes 取得
    const { data: minute, error: mErr } = await supabase
      .from('minutes')
      .select(
        'id, family_id, template_id, content_json, bbox_overrides, new_fields',
      )
      .eq('id', minuteId)
      .maybeSingle()
    if (mErr || !minute) {
      // 対象 ID が無いので markFailed 対象 ID 不明（update を試みても空打ち）。
      // 安全側に markFailed は呼ぶ（minuteId 引数は確実にある）。
      await markMinuteThumbnailFailed(supabase, minuteId)
      return { ok: false, code: 'MINUTE_NOT_FOUND' }
    }

    // builtin (family_id=null) は image_cache RLS の都合で生成不可（テンプレと同方針）。
    const familyId = (minute.family_id as string | null) ?? null
    if (!familyId) {
      await markMinuteThumbnailFailed(supabase, minuteId)
      return { ok: false, code: 'BUILTIN_NOT_SUPPORTED' }
    }

    if (!minute.template_id) {
      await markMinuteThumbnailFailed(supabase, minuteId)
      return { ok: false, code: 'TEMPLATE_NOT_FOUND' }
    }

    // 2. templates 取得（whiteout_boxes / source_path / fields / fixed_texts +
    //    family_id / processed_path も併取し builtin 経路を判定）
    const { data: tpl, error: tErr } = await supabase
      .from('templates')
      .select(
        'family_id, source_path, processed_path, whiteout_boxes, fields, fixed_texts',
      )
      .eq('id', minute.template_id)
      .maybeSingle()
    if (tErr || !tpl) {
      await markMinuteThumbnailFailed(supabase, minuteId)
      return { ok: false, code: 'TEMPLATE_NOT_FOUND' }
    }

    const sourcePath = tpl.source_path as string | null
    if (!sourcePath) {
      // builtin テンプレ（family_id=null + processed_path が seed 既定値）は raw PDF を
      // 持たないため raw 起点経路に乗らないが、public/builtin-templates/{slug}.bg.png
      // （値セル空白の背景 PNG）を直接サムネとして image_cache に upload することで救済する。
      // user テンプレで source_path が落ちている異常系（破損・移行漏れ等）は
      // 引き続き RAW_PATH_NOT_AVAILABLE を返し markFailed する。
      const tplFamilyId = (tpl.family_id as string | null) ?? null
      const processedPath = (tpl.processed_path as string | null) ?? null
      const builtinSlug =
        tplFamilyId === null
          ? resolveBuiltinBboxSlugFromProcessedPath(processedPath)
          : null
      if (!builtinSlug) {
        // raw PDF が無い ⇒ raw 起点では救済不能（確定的失敗）。
        await markMinuteThumbnailFailed(supabase, minuteId)
        return { ok: false, code: 'RAW_PATH_NOT_AVAILABLE' }
      }
      // bg.png 優先、見つからなければサムネ PNG にフォールバック（render-image と同方針）。
      const builtinPngBytes =
        (await loadBuiltinBackgroundPng(builtinSlug)) ??
        (await loadBuiltinThumbnailPng(builtinSlug))
      if (!builtinPngBytes) {
        await markMinuteThumbnailFailed(supabase, minuteId)
        return { ok: false, code: 'BUILTIN_PNG_NOT_FOUND' }
      }

      // builtin サムネにも content_json overlay を焼き込む。詳細画面の MinutesViewer は
      //   dpi=150 で render-image を叩くが、一覧画面などサムネ参照経路では
      //   minutes.thumbnail_path（image_cache）の dpi=72 PNG を直接 <img> 表示する。
      //   これも overlay 合成しないと値が一切見えない（render-image 修正と 1:1 対応・WYSIWYG）。
      const tplFieldsRaw = normalizeFields(tpl.fields)
      const tplFieldsMerged = mergeTemplateAndNewFields(
        tplFieldsRaw,
        parseNewFields(minute.new_fields),
      )
      const dbOverrides = parseFieldOverrides(minute.bbox_overrides)
      const fallbackFromJson = await loadBuiltinBboxOverrides(builtinSlug)
      const effectiveFields = buildBuiltinEffectiveFields({
        tplFields: tplFieldsMerged,
        dbOverrides,
        fallbackFromJson,
      })
      const valuesMap = flattenContent(minute.content_json)
      const overlayFieldsForBuiltin: MinuteOverlayField[] = []
      for (const f of effectiveFields) {
        const v = valuesMap[f.name]
        if (v === undefined || v === null) continue
        const text = String(v)
        if (text.length === 0) continue
        overlayFieldsForBuiltin.push({ field: f, value: text })
      }
      const pagePtSize = await loadBuiltinPagePtSize(builtinSlug)

      // 値 1 件以上 + pagePtSize 確定時のみ合成。失敗時は bg.png 直返しで安全側に退避
      //   （サムネは UX 上「値が見えないだけ」ですむ＝既存挙動への退避路）。
      let outBytes: Uint8Array = builtinPngBytes
      let outExt = 'png'
      let outContentType = 'image/png'
      if (overlayFieldsForBuiltin.length > 0 && pagePtSize) {
        try {
          const composed = await renderMinuteBuiltinBgWithOverlayToImages({
            bgPngBytes: builtinPngBytes,
            pagePtSize,
            overlayFields: overlayFieldsForBuiltin,
            requestedDpi: THUMB_DPI,
            format: THUMB_FORMAT,
            uniformTargetNames: new Set(effectiveFields.map((f) => f.name)),
            fixedTextNames: undefined,
            uniformOverridePt: readUniformOverridePt(dbOverrides) ?? undefined,
          })
          outBytes = composed.bytes
          outExt = composed.ext
          outContentType = composed.contentType
        } catch (err) {
          // サイレント退避を error 格上げ + stack 出力で真因を確実に拾う。
          console.error(
            `[generateMinuteThumbnail] builtin overlay composite FAILED → fallback to bg.png`,
            {
              minuteId,
              slug: builtinSlug,
              overlayFieldsCount: overlayFieldsForBuiltin.length,
              pagePtSize,
              message: err instanceof Error ? err.message : String(err),
              stack: err instanceof Error ? err.stack : undefined,
            },
          )
        }
      }
      return await uploadThumbnailAndMarkReady(supabase, {
        minuteId,
        familyId,
        bytes: outBytes,
        ext: outExt,
        contentType: outContentType,
      })
    }

    // 3. templates_raw バケットから raw PDF を download
    const { data: rawBlob, error: rawDlErr } = await supabase.storage
      .from('templates_raw')
      .download(sourcePath)
    if (rawDlErr || !rawBlob) {
      await markMinuteThumbnailFailed(supabase, minuteId)
      return { ok: false, code: 'RAW_FETCH_FAILED' }
    }
    const rawPdfBytes = new Uint8Array(await rawBlob.arrayBuffer())

    // 4. overlay fields 組み立て（render-image/route.ts と同パターン）。
    const rawTplFields = normalizeFields(tpl.fields)
    const tplFields = mergeTemplateAndNewFields(
      rawTplFields,
      parseNewFields(minute.new_fields),
    )
    const whiteoutBoxes: WhiteoutBox[] = Array.isArray(tpl.whiteout_boxes)
      ? (tpl.whiteout_boxes as unknown as WhiteoutBox[])
      : []
    const fixedTexts = normalizeFixedTexts(tpl.fixed_texts)
    const values = flattenContent(minute.content_json)
    const effectiveFields = applyFieldOverridesPure(
      tplFields,
      minute.bbox_overrides,
    )

    // 記入欄 field の overlayFields 構築。空値はスキップ（render-image と同様）。
    const overlayFields: MinuteOverlayField[] = []
    for (const f of effectiveFields) {
      const v = values[f.name]
      if (v === undefined || v === null) continue
      const text = String(v)
      if (text.length === 0) continue
      overlayFields.push({ field: f, value: text })
    }

    // 固定テキスト疑似 field を 1 件にまとめて overlayFields に積む（2026-06-14 改訂：行展開廃止）。
    //   配列で返るのは API 互換のため。`\n` 分割と中央配置は下流 layoutFixedTextLines が担う。
    const fixedTextNames = new Set<string>()
    for (const ft of fixedTexts) {
      const lineFields = fixedTextToPseudoFieldsByLines(ft)
      for (const lf of lineFields) {
        overlayFields.push({ field: lf.field, value: lf.value })
        fixedTextNames.add(lf.field.name)
      }
    }

    // 記入欄 field のみ uniform 対象（固定テキスト疑似は除外）。PDF 出力 / render-image と同集合。
    const uniformTargetNames = new Set(effectiveFields.map((f) => f.name))

    // 全体の文字サイズ手動上書き（既存規約継承）。
    const uniformOverridePt =
      readUniformOverridePt(parseFieldOverrides(minute.bbox_overrides)) ??
      undefined

    // 5. renderMinuteRawWithOverlayToImages 呼出（1 ページ限定 + DPI72 + PNG）。
    //    合成失敗時は throw → catch → markFailed（個人情報死守契約）。
    const result = await renderMinuteRawWithOverlayToImages({
      rawPdfBytes,
      whiteoutBoxes,
      overlayFields,
      pageRange: { from: 1, to: 1 },
      requestedDpi: THUMB_DPI,
      format: THUMB_FORMAT,
      asZip: false,
      uniformTargetNames,
      fixedTextNames,
      uniformOverridePt,
    })

    // 6 & 7. image_cache upload + minutes ready 遷移は共通ヘルパへ委譲（builtin 経路と DRY）。
    return await uploadThumbnailAndMarkReady(supabase, {
      minuteId,
      familyId,
      bytes: result.bytes,
      ext: result.ext,
      contentType: result.contentType,
    })
  } catch (err) {
    console.error(
      `[generateMinuteThumbnail] failed minuteId=${minuteId}:`,
      err instanceof Error ? err.message : String(err),
    )
    await markMinuteThumbnailFailed(supabase, minuteId)
    return { ok: false, code: 'RENDER_FAILED' }
  }
}

/**
 * サムネ bytes を image_cache に upload して minutes を ready 遷移させる共通ヘルパ。
 * raw 起点経路と builtin bg.png 経路の両方から使う。
 *
 * cacheKey 規約: `${familyId}/minutes/${minuteId}_72_png.${ext}`（DPI/format は raw 経路の
 *   render-image と互換）。builtin 経路でも bg.png は単一ページなので同じキーで上書きする。
 * image_cache バケットは UPDATE policy が無いため `upsert:true` だと 2 回目以降 RLS で
 *   弾かれる。テンプレ側と同型に remove → upload(upsert:false) で分割する。
 * upload 失敗 → markFailed + UPLOAD_FAILED / DB 更新失敗 → markFailed 二重打ち回避し DB_UPDATE_FAILED。
 */
async function uploadThumbnailAndMarkReady(
  supabase: SupabaseClient,
  args: {
    minuteId: string
    familyId: string
    bytes: Uint8Array
    ext: string
    contentType: string
  },
): Promise<MinuteThumbResult> {
  const { minuteId, familyId, bytes, ext, contentType } = args
  const cacheKey = `${familyId}/minutes/${minuteId}_${THUMB_DPI}_${THUMB_FORMAT}.${ext}`
  const thumbBlob = new Blob([bytes.slice().buffer], { type: contentType })

  await supabase.storage.from('image_cache').remove([cacheKey])
  const uploadRes = await supabase.storage
    .from('image_cache')
    .upload(cacheKey, thumbBlob, {
      contentType,
      upsert: false,
    })
  if (uploadRes.error) {
    await markMinuteThumbnailFailed(supabase, minuteId)
    return { ok: false, code: 'UPLOAD_FAILED' }
  }

  const { error: updErr } = await supabase
    .from('minutes')
    .update({ thumbnail_path: cacheKey, thumbnail_status: 'ready' })
    .eq('id', minuteId)
  if (updErr) {
    // ここは markFailed 二重打ち回避（DB 自体 NG 状態）。
    return { ok: false, code: 'DB_UPDATE_FAILED' }
  }

  return { ok: true, thumbnailPath: cacheKey }
}

/**
 * 議事録サムネ status を 'failed' に遷移させる共通関数。
 * regenerate-minute-pdf.ts の各 early return 経路でも呼び出して pending 据え置きを根絶。冪等。
 */
export async function markMinuteThumbnailFailed(
  supabase: SupabaseClient,
  minuteId: string,
): Promise<void> {
  await supabase
    .from('minutes')
    .update({ thumbnail_status: 'failed' })
    .eq('id', minuteId)
}

// ─────────────────────────────────────────────────────────────────────
// Helpers（regenerate-minute-pdf.ts / render-image/route.ts と同形のサーバ限定再利用）。
// ─────────────────────────────────────────────────────────────────────

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
