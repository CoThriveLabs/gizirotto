/**
 * GET /api/templates/[id]/bbox-editor
 * G2-1 設計書 v0.2 §4-1。
 *
 * bbox エディタ初期ロード用の軽量取得経路。
 *   - 背景 PNG signedUrl ＋ pageSizes（widthPt/heightPt/pixelWidth/pixelHeight）
 *   - bbox を持つ fields
 *   - fieldsVersion（fields 決定的 JSON の sha256、楽観ロック用）
 *
 * OCR/Claude/Tesseract は呼ばない（ラスタライズ + pageSizes 抽出のみ、§7 コスト $0）。
 * 認証 3 層ガードは render-image route（L40-66）と同型。
 *
 * Q8 フォールバック（§4-1 / spec §1-6 L610）:
 *   source_format!=='pdf' / background_pdf_path null / bbox 付き fields が 0 個
 *   → { editable:false, reason } を返し、保存 API は呼ばせない。
 *
 * Runtime: Node.js（renderPdfPagesToPng が worker_threads + pdfjs ネイティブ依存）。
 */
import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { loadBboxEditorPages } from '@/lib/pdf-output/bbox-editor-data'
import { computeFieldsVersion } from '@/lib/pdf-output/fields-version'
import { pickBboxFields } from '@/lib/pdf-output/bbox-save'
import type { WhiteoutBox } from '@/lib/parsers/pdf/whiteout-pipeline'
import type { FixedText } from '@/lib/pdf-output/fixedtext-adapter'
import { errorResponse } from '@/lib/api/error-response'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: templateId } = await params
  if (!templateId) {
    return NextResponse.json({ error: 'MISSING_TEMPLATE_ID' }, { status: 400 })
  }

  const supabase = await createSupabaseServerClient()

  // ガード ①: JWT 認証
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 })
  }

  // ガード ②: templates RLS（family_id 不一致は 0 件 → 404 隠蔽）
  const { data: template, error: tplErr } = await supabase
    .from('templates')
    .select(
      'id, family_id, source_format, background_pdf_path, fields, whiteout_boxes, fixed_texts, source_path',
    )
    .eq('id', templateId)
    .maybeSingle()
  if (tplErr) {
    return NextResponse.json({ error: 'DB_ERROR' }, { status: 500 })
  }
  if (!template) {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  }

  const dbFields = Array.isArray(template.fields)
    ? (template.fields as unknown[])
    : []
  const bboxFields = pickBboxFields(dbFields)

  // Q8 フォールバック判定: PDF 限定機能。位置調整不可なら editable:false で返す。
  if (
    template.source_format !== 'pdf' ||
    !template.background_pdf_path ||
    bboxFields.length === 0
  ) {
    const reason =
      template.source_format !== 'pdf'
        ? 'NOT_PDF'
        : !template.background_pdf_path
          ? 'NO_BACKGROUND'
          : 'NO_BBOX_FIELDS'
    // AdjustView は pageSizes が空だと「背景を読み込んでいます…」プレースホルダのまま
    // 無限ロードする。builtin/docx 等の非 PDF テンプレは bbox エディタ対象外 (editable:false)
    // だが、AdjustView 側で記入欄スクロールビューを描画させるため白紙 A4 1 ページ分の合成
    // pageSizes を返す（呼出側は editable で分岐するため pageSizes 追加は後方互換）。
    const SYNTHETIC_A4_PAGE = {
      page: 1,
      widthPt: 595,
      heightPt: 842,
      pixelWidth: 595,
      pixelHeight: 842,
    }
    return NextResponse.json(
      { editable: false, reason, pageSizes: [SYNTHETIC_A4_PAGE] },
      { status: 200 },
    )
  }

  // ガード ③: family_id（RLS を通過した時点で自家族 or builtin。builtin は family_id null）
  const familyId = (template.family_id as string | null) ?? 'builtin'

  // 白塗り座標があれば raw 背景＋再合成経路へ。null（旧データ）なら従来の _blank.pdf 経路。
  const whiteoutBoxes = Array.isArray(template.whiteout_boxes)
    ? (template.whiteout_boxes as unknown as WhiteoutBox[])
    : null

  // 固定テキスト編集モードの編集対象＝永続化済の fixed_texts。座標は左上原点 pt で
  // fields/whiteout と同一座標系（無変換で共用）。null/旧は空。
  const fixedTexts = Array.isArray(template.fixed_texts)
    ? (template.fixed_texts as unknown as FixedText[])
    : null

  // 背景ラスタライズ + pageSizes（OCR 無し軽量経路）。
  let pages
  try {
    pages = await loadBboxEditorPages(
      supabase,
      familyId,
      templateId,
      template.background_pdf_path as string,
      {
        whiteoutBoxes,
        // #17: 固定テキストは raw 焼き込みを撤回しクライアント動的合成（bbox-pane の canvas 経路）へ転換。
        //   route はクライアントに fixed_texts を返すだけで、loadBboxEditorPages には渡さない。
        sourcePath: (template.source_path as string | null) ?? null,
        // ②動的プレビュー（§2-2）: 白塗りモード用に raw 背景も併せて配信（記入欄/固定テキストは
        // 焼込済 previewImageUrls のまま無改修）。raw 配信は所有者本人編集前提で許容（§4-3・
        // 将来の公開 PF 化時は閲覧者判定で 'server' 強制へ切替）。
        compositePolicy: 'both',
        // §7（軽微）: raw 再アップロード時のブラウザ固着予防の cache bust 版数。
        // templates テーブルに updated_at 列が無いため **無効化（null 固定）**する（#17・DB_ERROR 回避）。
        // raw 固定方式なので白塗り編集中の固着は構造的に起きず（§7）、cache bust は必須ではない。
        // 将来 migration で updated_at 列＋自動更新トリガーを追加した時に template.updated_at で再有効化する受け皿。
        cacheVersion: null,
      },
    )
  } catch (err) {
    return errorResponse('BBOX_EDITOR_RENDER_FAILED', 500, err)
  }

  // 楽観ロック用バージョン（現 DB fields 全体のハッシュ。保存時に同送・比較）。
  const fieldsVersion = computeFieldsVersion(dbFields)

  // 取得時の整形（罫線スナップ／重なり軽減）は除去。DB 保存済み bbox をそのまま返す。
  //   ※②「保存しても戻る」（取得時 snap 無条件再適用が原因）と①「日時左辺に全揃え」を一手で解消。
  //   ※ snap/shrink の純関数定義と unit テストは温存（将来アップロード時焼込みで復活する退路）。
  return NextResponse.json(
    {
      editable: true,
      fields: bboxFields, // bbox を持つ field のみ（DB 原本＝ユーザー編集座標・UI は日本語 label を表示）
      pageSizes: pages.pageSizes,
      previewImageUrls: pages.previewImageUrls,
      // ②動的プレビュー（§2-2）: 白塗りモードの canvas 用 raw 背景（合成なし）。
      // null/未対応テンプレ（raw 無し）は previewImageUrls にフォールバックする（クライアント判断）。
      rawPreviewImageUrls: pages.rawPreviewImageUrls ?? null,
      fieldsVersion,
      // 白塗り編集モードの編集対象＝永続化済の whiteout_boxes をそのまま返す（座標は左上原点
      // pt で fields と同一座標系＝無変換で共用）。背景は raw 再合成で両モード共用。null/旧は空。
      whiteoutBoxes: whiteoutBoxes ?? [],
      // 固定テキスト編集モードの編集対象。null/旧データは空配列。
      fixedTexts: fixedTexts ?? [],
    },
    { status: 200 },
  )
}
