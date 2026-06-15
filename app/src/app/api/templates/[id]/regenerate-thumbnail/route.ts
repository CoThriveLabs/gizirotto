/**
 * POST /api/templates/[id]/regenerate-thumbnail
 *
 * テンプレサムネ画像の再生成（PY2-2 案A: family 所属メンバーなら可・role 不問）。
 * - PDF テンプレのみ対応。docx は `thumbnail_status='skipped'` のため 400 + NOT_SUPPORTED 返却。
 * - 既存 PDF サムネ生成パイプ（pdfjs-dist + @napi-rs/canvas、image_cache バケット）を流用。
 * - 完了後 `templates.thumbnail_path` / `thumbnail_status='ready'` を UPDATE。
 *
 * 認証ガード:
 *   1. JWT 認証 (getUser)
 *   2. middleware で family 所属チェック済（x-family-id ヘッダ）+ route 内で family_id 一致再確認
 *   3. family_members に所属（role 不問）確認。bbox 編集と権限を一貫させ failed 個体を
 *      家族メンバーが救済できるよう admin 限定から緩和（builtin は従来どおり不可）。
 */
import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { generateTemplateThumbnail } from '@/lib/pdf-output/template-thumbnail'
import type { WhiteoutBox } from '@/lib/parsers/pdf/whiteout-pipeline'
import type { FixedText } from '@/lib/pdf-output/fixedtext-adapter'

export const runtime = 'nodejs'
export const maxDuration = 30

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: templateId } = await params
  if (!templateId) {
    return NextResponse.json({ ok: false, code: 'MISSING_TEMPLATE_ID' }, { status: 400 })
  }

  const supabase = await createSupabaseServerClient()

  // 1. 認証
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ ok: false, code: 'UNAUTHENTICATED' }, { status: 401 })
  }

  // 2. テンプレ取得（RLS で family 不一致は弾かれる）
  const { data: template, error: tplErr } = await supabase
    .from('templates')
    .select(
      'id, family_id, source_format, background_pdf_path, thumbnail_status, source_path, whiteout_boxes, fixed_texts',
    )
    .eq('id', templateId)
    .maybeSingle()
  if (tplErr) {
    return NextResponse.json({ ok: false, code: 'DB_ERROR' }, { status: 500 })
  }
  if (!template) {
    return NextResponse.json({ ok: false, code: 'NOT_FOUND' }, { status: 404 })
  }

  // 3. docx テンプレは Phase 5a 中は再生成不可（Phase 5b で外部 SaaS 採用後に対応）
  if (template.source_format === 'docx' || template.thumbnail_status === 'skipped') {
    return NextResponse.json(
      { ok: false, code: 'NOT_SUPPORTED' },
      { status: 400 },
    )
  }

  if (!template.background_pdf_path) {
    return NextResponse.json(
      { ok: false, code: 'PDF_SOURCE_NOT_AVAILABLE' },
      { status: 404 },
    )
  }

  // 4. family 所属判定（PY2-2 案A: admin 限定→所属判定へ緩和）。
  // bbox 編集（updateTemplateFieldsBbox）が JWT+RLS の自家族のみで role 不問なのに
  // サムネ再生成だけ admin 必須なのは権限の非一貫だったため、family_members に所属
  // （role 不問）なら救済可に緩和する。image_cache RLS は「family 配下のみ INSERT」で
  // 越権面は増えない（他家族テンプレは RLS で 0 件→既に弾かれる）。
  // builtin (family_id=null) は image_cache RLS が family 配下のみ INSERT 可のため
  // 従来どおり生成不可（Phase 6 で builtin Storage policy 追加予定）。
  const familyId = template.family_id as string | null
  if (!familyId) {
    return NextResponse.json({ ok: false, code: 'BUILTIN_NOT_REGENERABLE' }, { status: 400 })
  }
  const { data: meRow } = await supabase
    .from('family_members')
    .select('user_id')
    .eq('family_id', familyId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!meRow) {
    return NextResponse.json({ ok: false, code: 'FORBIDDEN' }, { status: 403 })
  }

  // 5. PDF ダウンロード（経路分岐）
  // 白塗り座標があれば templates_raw の source_path を落として raw 背景＋whiteoutBoxes
  // 再合成でサムネ化する（A500 を踏む _blank.pdf をラスタライズしない）。
  // whiteout_boxes 無し/旧データは従来どおり templates_processed/background_pdf_path 経路。
  const whiteoutBoxes = Array.isArray(template.whiteout_boxes)
    ? (template.whiteout_boxes as unknown as WhiteoutBox[])
    : []
  // 固定テキストもサムネ画像に焼き込むため、whiteout と同様に raw（source_path）経路を選ぶ。
  // FixedText のバリデーションは generateTemplateThumbnail 側に委ねず、ここで最小限の形チェック
  //（regenerate-minute-pdf の normalizeFixedTexts と同型）で素性の悪い jsonb をフィルタする。
  const fixedTexts: FixedText[] = Array.isArray(template.fixed_texts)
    ? (template.fixed_texts as unknown[]).filter(
        (ft): ft is FixedText =>
          !!ft &&
          typeof ft === 'object' &&
          typeof (ft as { name?: unknown }).name === 'string' &&
          typeof (ft as { value?: unknown }).value === 'string' &&
          !!(ft as { bbox?: unknown }).bbox &&
          typeof (ft as { bbox: { page?: unknown } }).bbox.page === 'number',
      )
    : []
  const useRawWhiteoutPath =
    (whiteoutBoxes.length > 0 || fixedTexts.length > 0) && !!template.source_path

  let pdfBytes: Uint8Array
  if (useRawWhiteoutPath) {
    const { data: rawBlob, error: rawDlErr } = await supabase.storage
      .from('templates_raw')
      .download(template.source_path as string)
    if (rawDlErr || !rawBlob) {
      await supabase
        .from('templates')
        .update({ thumbnail_status: 'failed' })
        .eq('id', templateId)
      return NextResponse.json({ ok: false, code: 'PDF_DOWNLOAD_FAILED' }, { status: 500 })
    }
    pdfBytes = new Uint8Array(await rawBlob.arrayBuffer())
  } else {
    const pdfStoragePath = template.background_pdf_path as string
    const { data: pdfBlob, error: dlErr } = await supabase.storage
      .from('templates_processed')
      .download(pdfStoragePath)
    if (dlErr || !pdfBlob) {
      await supabase
        .from('templates')
        .update({ thumbnail_status: 'failed' })
        .eq('id', templateId)
      return NextResponse.json({ ok: false, code: 'PDF_DOWNLOAD_FAILED' }, { status: 500 })
    }
    pdfBytes = new Uint8Array(await pdfBlob.arrayBuffer())
  }

  // 6. サムネ生成（G1-④ 共通ヘルパーに委譲: render → image_cache upsert → DB 更新）。
  // ヘルパーは失敗時 status='failed' を記録し ok:false を返す。
  // whiteoutBoxes を渡すと raw を 1 ページ目だけラスタライズ→白塗り再合成（来なければ従来挙動）。
  // 再合成が例外失敗してもヘルパー側ガードで素の raw（白塗り前）は出力せず failed 記録に留まる
  //（個人情報死守）。
  const result = await generateTemplateThumbnail(supabase, {
    familyId,
    templateId,
    pdfBytes,
    ...(useRawWhiteoutPath && whiteoutBoxes.length > 0 ? { whiteoutBoxes } : {}),
    ...(useRawWhiteoutPath && fixedTexts.length > 0 ? { fixedTexts } : {}),
  })
  if (!result.ok) {
    return NextResponse.json({ ok: false, code: result.code }, { status: 500 })
  }

  return NextResponse.json(
    { ok: true, thumbnail_path: result.thumbnailPath },
    { status: 200 },
  )
}
