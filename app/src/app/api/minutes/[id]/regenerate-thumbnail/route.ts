/**
 * POST /api/minutes/[id]/regenerate-thumbnail
 *
 * 議事録サムネ画像の再生成。
 *
 * サムネ生成内部経路は raw 起点（renderMinuteRawWithOverlayToImages）。
 * `generateMinuteThumbnail` 内部が `templates_raw` から source_path を引いて
 * raw + overlay fields を組み立てる。
 *
 * 認可フロー:
 *   1. JWT 認証 (getUser) → 401 UNAUTHENTICATED
 *   2. minutes 取得（RLS で自家族のみ可視）→ 404 NOT_FOUND / 500 DB_ERROR
 *   3. family_id null（builtin）→ 400 BUILTIN_NOT_REGENERABLE
 *   4. family_members 所属チェック → 403 FORBIDDEN
 *   5. generateMinuteThumbnail 呼出 → 結果に応じて 200 / 500
 *      （内部 markFailed 済みなので route で重ねて呼ばない・暴走防止構造保持）
 *
 * 独自 rate limit は導入しない。本 route は手動ボタン / on-demand 自動 trigger 両方から呼ばれる。
 */
import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { generateMinuteThumbnail } from '@/lib/pdf-output/minute-thumbnail'

export const runtime = 'nodejs'
export const maxDuration = 30

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: minuteId } = await params
  if (!minuteId) {
    return NextResponse.json({ ok: false, code: 'MISSING_MINUTE_ID' }, { status: 400 })
  }

  const supabase = await createSupabaseServerClient()

  // 1. 認証
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ ok: false, code: 'UNAUTHENTICATED' }, { status: 401 })
  }

  // 2. 議事録取得（RLS で自家族のみ可視）
  //    v1.2: output_pdf_path は不要（raw 起点経路で参照しない）。
  const { data: minute, error: mErr } = await supabase
    .from('minutes')
    .select('id, family_id')
    .eq('id', minuteId)
    .maybeSingle()
  if (mErr) {
    return NextResponse.json({ ok: false, code: 'DB_ERROR' }, { status: 500 })
  }
  if (!minute) {
    return NextResponse.json({ ok: false, code: 'NOT_FOUND' }, { status: 404 })
  }

  // 3. builtin (family_id=null) は image_cache RLS の都合で生成不可（テンプレと同方針）。
  const familyId = minute.family_id as string | null
  if (!familyId) {
    return NextResponse.json(
      { ok: false, code: 'BUILTIN_NOT_REGENERABLE' },
      { status: 400 },
    )
  }

  // 4. family 所属判定（テンプレ PY2-2 案 A と同型・role 不問）
  const { data: meRow } = await supabase
    .from('family_members')
    .select('user_id')
    .eq('family_id', familyId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!meRow) {
    return NextResponse.json({ ok: false, code: 'FORBIDDEN' }, { status: 403 })
  }

  // 5. サムネ生成（共通ヘルパに委譲）
  //    v1.2: 内部で templates_raw / overlay fields を取得・合成。失敗時は内部で
  //    markFailed 済（ループ防止 α 構造保証）。
  const result = await generateMinuteThumbnail(supabase, { minuteId })
  if (!result.ok) {
    return NextResponse.json({ ok: false, code: result.code }, { status: 500 })
  }

  return NextResponse.json(
    { ok: true, thumbnail_path: result.thumbnailPath },
    { status: 200 },
  )
}
