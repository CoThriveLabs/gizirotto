/**
 * POST /api/minutes/{id}/export/pdf
 * 設計書 v1.4.2 §6-4 / 仕様書 v1.6.1 §1-6（PDF レイアウト保持出力）。
 *
 * blank.pdf + fields + fieldValues → オーバーレイで完成 PDF 生成。
 * Phase 5 議事録 PDF 出力本体。
 *
 * Runtime: Node.js（pdf-lib + fontkit + Noto Sans CJK JP embedFont）
 * maxDuration: 30 秒（フィッティング 3 段 + drawText）
 *
 * 本セッション (Week 5) のスコープ:
 *   - ルーティング + 認証 + バリデーション + generateOverlayPdf 呼出までの統合
 *   - 実際の minutes / templates / user_styles 取得は Phase 3-5 で実装する
 *     domain layer に委譲（本ファイル内では Storage / DB I/O を fetch 想定で抽象化）
 */
import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { generateOverlayPdf } from '@/lib/pdf-output/overlay-generator'
import { errorResponse } from '@/lib/api/error-response'

export const runtime = 'nodejs'
export const maxDuration = 30

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: minutesId } = await params

  if (!minutesId) {
    return NextResponse.json({ error: 'MISSING_MINUTES_ID' }, { status: 400 })
  }

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 })
  }

  // === 実 I/O 統合は Phase 3-5 で domain layer 完成後 ===
  // 1. minutes 取得 + templates / user_styles JOIN
  // 2. background_pdf_path から Storage 経由で blank.pdf 取得
  // 3. minutes.content_json から field_name → text マップ取得（or Claude §6-4.5 で生成）
  // 4. user_styles.profile.padding_pattern から userStylePadding 構築
  // 5. generateOverlayPdf 呼出
  // 6. outputs バケット保存 + 署名付き URL 返却

  // Phase 2.5 Week 5 時点では、上記 1-4 をモック / 簡易実装で受けて
  // generateOverlayPdf の動作確認エンドポイントとして暫定提供する。
  // request body で fields / fieldValues / blankPdfBase64 を受ければそのまま動く構造。

  // === 暫定: request body から直接受ける開発者向け経路 ===
  const body = (await _request.json().catch(() => null)) as {
    blankPdfBase64?: string
    fields?: unknown
    fieldValues?: Record<string, string>
  } | null

  if (
    !body
    || !body.blankPdfBase64
    || !body.fields
    || !body.fieldValues
  ) {
    return NextResponse.json(
      {
        error: 'DOMAIN_INTEGRATION_PENDING',
        detail:
          'Phase 3-5 で minutes / templates / user_styles 取得を統合予定。'
          + ' Week 5 暫定として request body に { blankPdfBase64, fields, fieldValues } を渡せば overlay 生成する開発者向け経路を提供。',
      },
      { status: 501 },
    )
  }

  try {
    const blankPdfBytes = Uint8Array.from(
      Buffer.from(body.blankPdfBase64, 'base64'),
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await generateOverlayPdf({
      blankPdfBytes,
      fields: body.fields as any,
      fieldValues: body.fieldValues,
    })
    return new NextResponse(Buffer.from(result.pdfBytes) as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="minutes-${minutesId}.pdf"`,
        'X-Overlay-Warnings': JSON.stringify(result.warnings),
      },
    })
  } catch (err) {
    return errorResponse('OVERLAY_GENERATION_FAILED', 500, err)
  }
}
