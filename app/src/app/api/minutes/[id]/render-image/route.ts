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
import { clampDpi } from '@/lib/pdf-output/dpi-downgrade'
import { flattenContent } from '@/lib/utils/minutes-output'
import { buildRawCacheSuffix } from '@/lib/pdf-output/render-image-overlay-filter'
import {
  mergeTemplateAndNewFields,
  parseNewFields,
} from '@/lib/pdf-output/merge-template-and-new-fields'
import type { TplRow, RenderSourceResult } from './render-source-types'
import { resolveRawOverlayRender } from './render-source-raw-overlay'
import { resolveBuiltinBgRender } from './render-source-builtin-bg'
import { resolveFallbackRender } from './render-source-fallback'
import { normalizeFields } from './render-image-helpers'

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

  let resolved: RenderSourceResult
  if (canUseRawOverlay) {
    // 案 A: raw 起点で純画像合成（A500 を構造的に回避）。
    const values = flattenContent(minutes.content_json)
    resolved = await resolveRawOverlayRender({
      supabase,
      template: template!,
      tplFields,
      values,
      bboxOverrides: minutes.bbox_overrides,
      pageRange,
      dpi,
      format,
      asZip,
      raw,
      rawExceptSelected,
    })
  } else if (template && template.source_format !== 'pdf') {
    resolved = await resolveBuiltinBgRender({
      template,
      tplFields,
      bboxOverrides: minutes.bbox_overrides,
      contentJson: minutes.content_json,
      minutesId,
      dpi,
      format,
      raw,
    })
  } else {
    // フォールバック経路（後方互換）。output_pdf_path → background_pdf_path → 404。
    resolved = await resolveFallbackRender({
      supabase,
      outputPdfPath: (minutes.output_pdf_path as string | null) ?? null,
      template,
      pageRange,
      dpi,
      format,
      asZip,
      forceDpi,
    })
  }
  if (!resolved.ok) return resolved.response
  const result = resolved.result

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
