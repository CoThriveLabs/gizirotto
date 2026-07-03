import { NextResponse } from 'next/server'
import type { renderPdfToImages } from '@/lib/pdf-output/image-render-worker'

/** templates テーブルから取得する行の型（render-image route 専用の絞り込み列）。 */
export interface TplRow {
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

/**
 * 分岐処理（raw-overlay/builtin-bg/fallback）の共通戻り値。
 * エラー時は route.ts がそのまま return できる NextResponse を持たせ、
 * 早期return構造（既存分岐の呼び出し順・status/bodyを1文字も変えない）を維持する。
 */
export type RenderSourceResult =
  | { ok: true; result: Awaited<ReturnType<typeof renderPdfToImages>> }
  | { ok: false; response: NextResponse }
