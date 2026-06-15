/**
 * POST /api/minutes/[id]/render-image
 * 設計書 v1.4.8 §6-7 / §6-7-b（render-image API 議事録 PDF 経路）。
 *
 * 議事録 PDF を画像（PNG / 複数ページ ZIP）に変換する。
 * image_cache バケットでキャッシュ（TTL 7 日、cron 削除は §6-8）。
 *
 * 認証ガード 3 層（§3-10-e）:
 *   ① JWT family_id 照合（Supabase Auth getUser）
 *   ② minutes RLS（family_id 不一致は 404 隠蔽）
 *   ③ image_cache バケット RLS（§5-5）
 *
 * Runtime: Node.js（pdfjs-dist + @napi-rs/canvas Edge 非対応、§6-7-a）
 * maxDuration: 30 秒（Hobby 標準内、§6-7-a）
 *
 * Phase 3 第 2 週スコープ:
 *   - 認証 + キャッシュ hit/miss 判定 + ファクトリ経由 render-worker 呼出
 *   - 議事録 PDF 本体は overlay 生成済前提（Phase 3-5 で domain 統合）
 *     Phase 3 第 2 週時点では `minutes.output_pdf_path` から取得 or
 *     `background_pdf_path`（テンプレ流用）にフォールバック
 */
import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import {
  renderPdfToImages,
  renderMinuteRawWithOverlayToImages,
  renderMinuteBuiltinBgWithOverlayToImages,
  getPdfNumPages,
  type MinuteOverlayField,
} from '@/lib/pdf-output/image-renderer'
import { clampDpi } from '@/lib/pdf-output/dpi-downgrade'
import type { WhiteoutBox } from '@/lib/parsers/pdf/whiteout-pipeline'
import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'
import type { FixedText } from '@/lib/pdf-output/fixedtext-adapter'
import { fixedTextToPseudoFieldsByLines } from '@/lib/pdf-output/regenerate-minute-pdf'
import { flattenContent } from '@/lib/utils/minutes-output'
import {
  buildOverlayFieldsForRender,
  buildRawCacheSuffix,
} from '@/lib/pdf-output/render-image-overlay-filter'
import {
  mergeTemplateAndNewFields,
  parseNewFields,
} from '@/lib/pdf-output/merge-template-and-new-fields'
import { readUniformOverridePt } from '@/lib/pdf-output/uniform-override'
import { parseFieldOverrides } from '@/lib/pdf-output/field-override'
import { buildBuiltinEffectiveFields } from '@/lib/pdf-output/builtin-overlay-resolver'
import { generateBlankA4Png } from '@/lib/pdf-output/blank-a4-png'
import {
  resolveBuiltinBboxSlugFromProcessedPath,
  loadBuiltinThumbnailPng,
  loadBuiltinBackgroundPng,
  loadBuiltinPagePtSize,
} from '@/lib/builtin-bbox-loader'
import { errorResponse } from '@/lib/api/error-response'

export const runtime = 'nodejs'
export const maxDuration = 30

interface RenderImageRequestBody {
  dpi?: number
  format?: 'png' | 'jpeg'
  pageRange?: { from: number; to: number }
  asZip?: boolean
  forceDpi?: boolean
  /**
   * 段階2-D2（設計書 v2.0 §1-2-2・R6 確定）: raw モード。
   *
   * AdjustView の動的プレビュー背景用に「記入値ゼロ」の PNG を返す。
   * 動作:
   *   - 白塗り合成: 通常どおり適用（white-out したラベル等は出ない）
   *   - 固定テキスト: 通常どおり焼き込み（テンプレ自身のラベル相当・記入値ではない）
   *   - 記入欄 field（content_json 値）: **空に置換して overlay 描画スキップ**
   * これにより AdjustView が背景 raw + クライアント canvas 合成（compositeFieldValuesOnCanvas）
   * の二層構成を作れ、二重描画ゼロを実現する（§7-B 焼き込み残り二重描画ゼロ）。
   *
   * キャッシュは raw=true / false で別キーに分離する（同議事録・同 dpi で 2 つ持つ）。
   * 省略時 false で完全後方互換（既存呼出は影響なし）。
   */
  raw?: boolean
  /**
   * 🔴 段階2-D3 案 D（設計書 v2.5 §1-2-6-2）: 編集中 field 以外を焼き込み済 PNG 背景に格納。
   *
   * `raw === true` かつ `raw_except_selected` 指定時のみ作用: overlayFields ループで
   * 指定された field name **だけ**を値スキップ（=未焼き込みのまま背景から除外）し、
   * それ以外の field は通常どおり overlay に積む（=焼き込み済として PNG に焼く）。
   *
   * これにより AdjustView の selected field 切替時に「他 field は PDF と構造的に完全一致の
   * 焼き込み済 PNG」+「selected field のみ canvas 動的合成」の二層構成を実現する。
   *
   * 後方互換:
   *   - `raw === true` で `raw_except_selected` 未指定 = 既存挙動（全 field スキップ）
   *   - `raw === false` = 既存挙動（全 field overlay）。本フラグは無視される
   *
   * キャッシュキーには `_except_${name}` 接尾辞を付与し、name 単位で別キャッシュにする
   * （編集 field 切替時に他 field の焼き込み済 PNG を使い回せる・TTL 7 日据置）。
   */
  raw_except_selected?: string
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: minutesId } = await params
  if (!minutesId) {
    return NextResponse.json({ error: 'MISSING_MINUTES_ID' }, { status: 400 })
  }

  const supabase = await createSupabaseServerClient()

  // ガード ①: JWT 認証
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 })
  }

  // ガード ②: minutes RLS（family_id 不一致は 0 件 → 404 隠蔽）
  const { data: minutes, error: minutesErr } = await supabase
    .from('minutes')
    .select(
      'id, title, meeting_date, family_id, output_pdf_path, template_id, content_json, bbox_overrides, new_fields',
    )
    .eq('id', minutesId)
    .maybeSingle()
  if (minutesErr) {
    return NextResponse.json({ error: 'DB_ERROR' }, { status: 500 })
  }
  if (!minutes) {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  }
  const familyId = minutes.family_id as string

  // リクエスト解析
  const body = (await request.json().catch(() => ({}))) as RenderImageRequestBody
  const dpi = clampDpi(body.dpi, 150)
  const format: 'png' | 'jpeg' = body.format === 'jpeg' ? 'jpeg' : 'png'
  const asZip = body.asZip ?? false
  const forceDpi = body.forceDpi ?? false
  const pageRange = body.pageRange
  // 段階2-D2（v2.0 §1-2-2・R6）: raw モードフラグ。記入値ゼロの背景 PNG を返す。
  const raw = body.raw === true
  // 🔴 段階2-D3 案 D（v2.5 §1-2-6-2）: raw=true 時のみ作用。指定 field 1 つだけスキップ。
  // raw=false や未指定時は undefined（既存挙動）。
  const rawExceptSelected =
    raw && typeof body.raw_except_selected === 'string'
      ? body.raw_except_selected
      : undefined

  // image_cache hit 確認（§5-5、§6-7-a キャッシュ戦略）
  // キー仕様: {family_id}/minutes/{id}_{dpi}_{format}.{ext|zip}
  // jpeg はファイル拡張子として jpg を使う（一般慣行）
  const formatExt = format === 'jpeg' ? 'jpg' : 'png'
  const cacheExt = asZip ? 'zip' : formatExt
  // raw=true は別キー。記入値ありの通常キャッシュと混ざらないよう _raw を付ける（§1-2-2 キャッシュ分離）。
  // 🔴 段階2-D3 案 D: raw_except_selected 指定時は `_raw_except_${name}` 接尾。
  //   sanitize / 接尾辞生成は buildRawCacheSuffix（pure・unit test カバー）に集約。
  const rawSuffix = buildRawCacheSuffix(raw, rawExceptSelected)
  const cacheKey = `${familyId}/minutes/${minutesId}_${dpi}_${format}${rawSuffix}.${cacheExt}`
  const { data: cached } = await supabase.storage
    .from('image_cache')
    .createSignedUrl(cacheKey, 3600)
  if (cached?.signedUrl) {
    return NextResponse.json(
      {
        cached: true,
        signedUrl: cached.signedUrl,
        cacheKey,
      },
      { status: 200 },
    )
  }

  // miss: PDF 取得
  // ──────────────────────────────────────────────────────────────────────
  // 案 A（minutes_overlay_a500_research §4）: raw 起点に切替
  // ──────────────────────────────────────────────────────────────────────
  // 既存経路は `minutes.output_pdf_path`（overlay 済 _blank.pdf）を rasterize していたが、
  // overlay-generator の pdf-lib 二段保存で画像 XObject が変質し A500 を踏む。
  // 画像化経路だけ「raw → ラスタライズ → 白塗り PNG 再合成 → 本文 drawText を canvas で焼く」
  // に差し替える。出力 PDF/Word はそのまま overlay-generator 経路を温存（仕様逸脱なし）。
  //
  // 優先順位:
  //   ① template が揃っていて (source_path + fields + 全 bbox) を満たす → 案 A 経路
  //   ② それ以外で output_pdf_path がある → 従来 overlay PDF rasterize（後方互換）
  //   ③ template の background_pdf_path フォールバック（白塗りなし旧データ）
  //   ④ いずれも無理 → 404
  let result: Awaited<ReturnType<typeof renderPdfToImages>>

  type TplRow = {
    id: string
    family_id: string | null
    background_pdf_path: string | null
    source_path: string | null
    source_format: string | null
    processed_path: string | null
    whiteout_boxes: unknown
    fields: unknown
    fixed_texts: unknown
  }
  let template: TplRow | null = null
  if (minutes.template_id) {
    const { data: t } = await supabase
      .from('templates')
      .select(
        'id, family_id, background_pdf_path, source_path, source_format, processed_path, whiteout_boxes, fields, fixed_texts',
      )
      .eq('id', minutes.template_id)
      .maybeSingle()
    template = (t as TplRow | null) ?? null
  }

  const rawTplFields = normalizeFields(template?.fields)
  // minute 固有の追加 field を末尾合流。
  //   regenerate-minute-pdf.ts と同じ純関数を通すことで PDF 出力と画像出力で同一の field 集合
  //   になり WYSIWYG を保証する。
  const tplFields = mergeTemplateAndNewFields(
    rawTplFields,
    parseNewFields(minutes.new_fields),
  )
  const hasAllBbox =
    tplFields.length > 0 &&
    tplFields.every(
      (f) =>
        !!f.bbox &&
        typeof (f.bbox as { page?: unknown }).page === 'number',
    )
  const canUseRawOverlay =
    !!template && !!template.source_path && hasAllBbox

  if (canUseRawOverlay) {
    // 案 A: raw 起点で純画像合成（A500 を構造的に回避）。
    const { data: rawBlob, error: rawDlErr } = await supabase.storage
      .from('templates_raw')
      .download(template!.source_path as string)
    if (rawDlErr || !rawBlob) {
      return NextResponse.json({ error: 'PDF_DOWNLOAD_FAILED' }, { status: 500 })
    }
    const rawBytes = new Uint8Array(await rawBlob.arrayBuffer())

    const whiteoutBoxes = Array.isArray(template!.whiteout_boxes)
      ? (template!.whiteout_boxes as unknown as WhiteoutBox[])
      : []
    const fixedTexts = normalizeFixedTexts(template!.fixed_texts)
    const values = flattenContent(minutes.content_json)
    const effectiveFields = applyBboxOverrides(tplFields, minutes.bbox_overrides)

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
      readUniformOverridePt(parseFieldOverrides(minutes.bbox_overrides)) ?? undefined

    try {
      result = await renderMinuteRawWithOverlayToImages({
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
    } catch (err) {
      return errorResponse('IMAGE_RENDER_FAILED', 500, err)
    }
  } else if (template && template.source_format !== 'pdf') {
    // builtin/docx 等の非 PDF テンプレ（source_format !== 'pdf'）は raw 起点経路に乗せられない
    // 上、output_pdf_path（simple-pdf 生成）も pdfjs+napi-rs/canvas で
    // 「Value is none of these types `String`, `Path`」エラーを発生させる
    // （embedNotoSansCJKjp 由来の OTF を pdfjs が認識できない経路）。
    //
    // builtin テンプレ（family_id === null かつ processed_path が seed の slug いずれか）の
    //   場合は `public/builtin-templates/{slug}.png`（テーブル/ラベル/罫線レイアウトを含む
    //   サムネ PNG）を背景として返す。AdjustView はこの背景上に初期 bbox を重ねるため
    //   「テンプレ既視感のあるレイアウト + bbox」の意図された見た目になる。
    //
    //   それ以外（user テンプレ docx 等、builtin slug 不一致）は白紙 A4 PNG fallback を温存。
    //
    // 値が 1 件でも入っている通常表示時は bg.png + overlay drawText を canvas 合成する
    //   （raw=true は AdjustView 動的プレビュー用なので bg.png 直返しを維持）。
    try {
      let builtinPngBytes: Uint8Array | null = null
      let builtinSlug: ReturnType<typeof resolveBuiltinBboxSlugFromProcessedPath> = null
      if (template.family_id === null) {
        builtinSlug = resolveBuiltinBboxSlugFromProcessedPath(template.processed_path)
        if (builtinSlug) {
          // 背景用 PNG（`{slug}.bg.png`・値セル空白）を優先採用。
          //   サムネ `{slug}.png`（ダミー値入り）を背景に流用するとユーザー入力値と
          //   二重表示される UX バグになる。背景 PNG が無い場合（コミット漏れ等の保険）は
          //   サムネ PNG にフォールバック → 最後は白紙 A4。
          builtinPngBytes =
            (await loadBuiltinBackgroundPng(builtinSlug)) ??
            (await loadBuiltinThumbnailPng(builtinSlug))
        }
      }

      // bg.png 取得済 + raw=false（通常表示・詳細画面）+ builtin slug 有効の場合に overlay
      //   合成を試みる。raw=true は AdjustView の動的プレビュー用なので「記入値ゼロ背景」を
      //   返す既存契約を維持。
      if (builtinPngBytes && !raw && builtinSlug !== null) {
        const pagePtSize = await loadBuiltinPagePtSize(builtinSlug)
        const dbOverrides = parseFieldOverrides(minutes.bbox_overrides)
        // builtin tplFields は seed.sql 由来で bbox を持たないので、bbox は dbOverrides
        //   （ユーザー編集差分・最優先）→ bbox JSON fallback（builtin 初期値）の順で補完。
        //   user テンプレ raw 経路の applyBboxOverrides と式同型（builtin 仕様の equivalent）。
        const { loadBuiltinBboxOverrides: loadBboxFromJson } = await import(
          '@/lib/builtin-bbox-loader'
        )
        const fallbackFromJson = await loadBboxFromJson(builtinSlug)
        const effectiveFields = buildBuiltinEffectiveFields({
          tplFields,
          dbOverrides,
          fallbackFromJson,
        })

        const valuesMap = flattenContent(minutes.content_json)
        const overlayFields: MinuteOverlayField[] = []
        for (const f of effectiveFields) {
          const v = valuesMap[f.name]
          if (v === undefined || v === null) continue
          const text = String(v)
          if (text.length === 0) continue
          overlayFields.push({ field: f, value: text })
        }

        // 値 1 件以上 + pagePtSize 確定時のみ合成。失敗時は bg.png に退避（安全側）。
        if (overlayFields.length > 0 && pagePtSize) {
          const uniformTargetNames = new Set(effectiveFields.map((f) => f.name))
          const uniformOverridePt =
            readUniformOverridePt(dbOverrides) ?? undefined
          try {
            result = await renderMinuteBuiltinBgWithOverlayToImages({
              bgPngBytes: builtinPngBytes,
              pagePtSize,
              overlayFields,
              requestedDpi: dpi,
              format,
              uniformTargetNames,
              fixedTextNames: undefined,
              uniformOverridePt,
            })
          } catch (err) {
            // サイレント退避で「値が見えない」現象を引き起こす経路。
            //   error 格上げ + stack 出力で再現時に真因を確実に拾えるようにする。
            //   bg.png 退避自体は据置（詳細画面を真っ白にしないための安全網）。
            console.error(
              '[render-image] builtin overlay composite FAILED → fallback to bg.png',
              {
                minuteId: minutesId,
                slug: builtinSlug,
                overlayFieldsCount: overlayFields.length,
                pagePtSize,
                message: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined,
              },
            )
            result = {
              bytes: builtinPngBytes,
              contentType: 'image/png',
              ext: 'png',
              dpiDecision: { dpi, downgraded: false, estimatedMs: 0 },
              renderedPages: 1,
              warnings: [],
            }
          }
        } else {
          // 値ゼロ or pagePtSize 取得失敗 → bg.png 直返し（既存挙動）。
          result = {
            bytes: builtinPngBytes,
            contentType: 'image/png',
            ext: 'png',
            dpiDecision: { dpi, downgraded: false, estimatedMs: 0 },
            renderedPages: 1,
            warnings: [],
          }
        }
      } else if (builtinPngBytes) {
        // raw=true or slug 未解決 → bg.png 直返し（既存挙動）。
        result = {
          bytes: builtinPngBytes,
          contentType: 'image/png',
          ext: 'png',
          dpiDecision: { dpi, downgraded: false, estimatedMs: 0 },
          renderedPages: 1,
          warnings: [],
        }
      } else {
        const blank = await generateBlankA4Png(dpi)
        result = {
          bytes: blank.bytes,
          contentType: 'image/png',
          ext: 'png',
          dpiDecision: { dpi, downgraded: false, estimatedMs: 0 },
          renderedPages: 1,
          warnings: [],
        }
      }
    } catch (err) {
      return errorResponse('IMAGE_RENDER_FAILED', 500, err)
    }
  } else {
    // フォールバック経路（後方互換）。output_pdf_path → background_pdf_path → 404。
    const pdfPath = (minutes.output_pdf_path as string | null) ?? null
    let pdfBucket: 'minutes_output' | 'templates_processed'
    let pdfStoragePath: string
    if (pdfPath) {
      pdfBucket = 'minutes_output'
      pdfStoragePath = pdfPath
    } else if (template?.background_pdf_path) {
      pdfBucket = 'templates_processed'
      pdfStoragePath = template.background_pdf_path
    } else {
      return NextResponse.json(
        { error: 'PDF_SOURCE_NOT_AVAILABLE' },
        { status: 404 },
      )
    }

    const { data: pdfBlob, error: dlErr } = await supabase.storage
      .from(pdfBucket)
      .download(pdfStoragePath)
    if (dlErr || !pdfBlob) {
      return NextResponse.json({ error: 'PDF_DOWNLOAD_FAILED' }, { status: 500 })
    }
    const pdfBytes = new Uint8Array(await pdfBlob.arrayBuffer())

    let totalPages: number
    try {
      totalPages = await getPdfNumPages(pdfBytes)
    } catch {
      return NextResponse.json({ error: 'PDF_NUMPAGES_FAILED' }, { status: 500 })
    }

    try {
      result = await renderPdfToImages({
        pdfBytes,
        totalPages,
        pageRange,
        requestedDpi: dpi,
        format,
        asZip,
        forceDpi,
      })
    } catch (err) {
      return errorResponse('IMAGE_RENDER_FAILED', 500, err)
    }
  }

  // image_cache 保存（§5-5、§6-7-a）
  // 失敗しても応答は返す（次回 miss してまた生成するだけ）
  await supabase.storage
    .from('image_cache')
    .upload(cacheKey, result.bytes as unknown as Blob, {
      contentType: result.contentType,
      upsert: true,
    })

  // 署名付き URL 発行
  const { data: signed } = await supabase.storage
    .from('image_cache')
    .createSignedUrl(cacheKey, 3600)

  return NextResponse.json(
    {
      cached: false,
      signedUrl: signed?.signedUrl ?? null,
      cacheKey,
      contentType: result.contentType,
      ext: result.ext,
      renderedPages: result.renderedPages,
      dpi: result.dpiDecision.dpi,
      originalDpi: result.dpiDecision.originalDpi,
      downgraded: result.dpiDecision.downgraded,
      estimatedMs: result.dpiDecision.estimatedMs,
      warnings: result.warnings,
    },
    { status: 200 },
  )
}

// ─────────────────────────────────────────────────────────────────────
// Helpers（regenerate-minute-pdf.ts 同梱版のサーバ限定再利用。クライアント共有純
// 関数とは同居させない・mistake.md 2026-06-06 違反事例を踏まないため route.ts 内に閉じる）。
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

function applyBboxOverrides(fields: PdfField[], overrides: unknown): PdfField[] {
  if (!overrides || typeof overrides !== 'object') return fields
  const ov = overrides as Record<string, { x?: unknown; y?: unknown }>
  return fields.map((f) => {
    const o = ov[f.name]
    if (!o || typeof o.x !== 'number' || typeof o.y !== 'number') return f
    return { ...f, bbox: { ...f.bbox, x: o.x, y: o.y } }
  })
}
