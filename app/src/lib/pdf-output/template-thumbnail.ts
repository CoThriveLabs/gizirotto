/**
 * テンプレサムネ生成の共通ヘルパー（G1-④、設計書 g1_ux_quickwin_design_v0.2 §1-2）。
 *
 * これまで PDF テンプレのサムネは手動 API（regenerate-thumbnail/route.ts）からしか
 * 生成されず、upload 時は DB 既定の 'pending' のまま放置されていた。
 * 本ヘルパーを upload 時（パス A）/ 白塗り適用後（パス B）/ 手動 API（救済用に温存）の
 * 3 経路から呼べるように切り出し、minutes 側（regenerate-minute-pdf.ts）と同形の
 * 「dpi72 / png / 1ページ目を image_cache に upsert → ready/failed 遷移」を実装する。
 *
 * 失敗してもサムネ status を 'failed' に記録するのみで throw しない（upload を落とさない）。
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { renderPdfToImages, getPdfNumPages } from './image-renderer'
import { renderPdfPagesToPng } from '@/lib/parsers/pdf/pdf-page-rasterizer'
import { compositeWhiteoutOnPng } from '@/lib/parsers/pdf/whiteout-composite'
import type { WhiteoutBox } from '@/lib/parsers/pdf/whiteout-pipeline'
import { compositeFixedTextsOnPng } from './fixedtext-composite'
import type { FixedText } from './fixedtext-adapter'

/** サムネ生成パラメータ（minutes 側と同値、§4「新規 const」）。 */
export const THUMB_DPI = 72
export const THUMB_FORMAT = 'png' as const

/**
 * 白塗り再合成サムネのラスタライズ scale。
 * renderPdfPagesToPng の scale 1.0 が 72dpi 相当（= THUMB_DPI）。
 * サムネ既存挙動（dpi72）と画素サイズを揃えるため 1.0 を使う。
 */
const THUMB_RASTER_SCALE = THUMB_DPI / 72

export type TemplateThumbResult =
  | { ok: true; thumbnailPath: string }
  | { ok: false; code: string }

interface GenerateTemplateThumbnailInput {
  /** テンプレの family_id（image_cache のキー prefix に使う）。null は builtin で生成不可。 */
  familyId: string | null
  templateId: string
  /**
   * 背景 PDF のバイト列。呼出側でダウンロード済を渡す。
   * 白塗りパス B では **raw PDF** を渡し、whiteoutBoxes で再合成する
   * （A500 を踏む blank PDF をラスタライズしない）。パス A / docx / 救済 API は従来通り
   * 焼き込み or raw をそのまま渡す（whiteoutBoxes 省略で従来挙動）。
   */
  pdfBytes: Uint8Array
  /**
   * 白塗り座標（全ページ可・pt・左上原点）。
   * 指定があれば pdfBytes（raw）をラスタライズ→1ページ目に再合成してサムネ化する。
   * 省略 or 空配列なら従来の renderPdfToImages 経路（非破壊）。
   */
  whiteoutBoxes?: WhiteoutBox[]
  /**
   * 固定テキスト要素（全ページ可・pt・左上原点）。
   * 1 件でも 1 ページ目の要素があれば pdfBytes（raw）をラスタライズ→PNG 上に上書き描画して
   * サムネ画像の中身に固定テキストを焼き込む。whiteoutBoxes と同時指定時は
   * 「ラスタライズ → 白塗り → 固定テキスト」の順で同一 PNG に重ねる
   * （drawText が白塗りの上に乗る overlay PDF と同順序）。
   * 省略 or 空配列なら従来挙動（固定テキスト無し）。
   */
  fixedTexts?: FixedText[]
}

/**
 * blank PDF からサムネ画像を生成し image_cache に保存、templates の
 * thumbnail_path / thumbnail_status を更新する。
 *
 * 返り値で結果を伝えるが、内部例外は握り潰して 'failed' を DB に記録する
 * （upload / 白塗り適用のクリティカルパスを落とさないため）。
 */
export async function generateTemplateThumbnail(
  supabase: SupabaseClient,
  { familyId, templateId, pdfBytes, whiteoutBoxes, fixedTexts }: GenerateTemplateThumbnailInput,
): Promise<TemplateThumbResult> {
  // builtin（family_id=null）は image_cache RLS が family 配下のみ INSERT 可のため生成不可。
  if (!familyId) {
    return { ok: false, code: 'BUILTIN_NOT_SUPPORTED' }
  }

  const hasWhiteout = Array.isArray(whiteoutBoxes) && whiteoutBoxes.length > 0
  // 固定テキストもサムネ画像に焼き込む必要があるため raw ラスタライズ経路に分岐。
  const hasFixedTexts = Array.isArray(fixedTexts) && fixedTexts.length > 0
  const useRasterPath = hasWhiteout || hasFixedTexts

  try {
    // サムネ画像バイト・拡張子・Content-Type を経路ごとに用意し、以降の upload/DB は共通化する。
    let thumbBytes: Uint8Array
    let ext: string
    let contentType: string

    if (useRasterPath) {
      // raw PDF を 1 ページ目だけ scale 1.0（=72dpi 相当）でラスタライズし、
      // 白塗り → 固定テキストの順で PNG に上書き合成する
      // （overlay PDF 出力の重なり順と同順序: 背景 → 白塗り → drawText）。
      // 白塗り再合成が失敗したら catch に落ち、素の raw PNG は upload せず 'failed' を記録する
      // （個人情報死守: 漏洩より表示不能を選ぶ）。固定テキスト合成失敗も同様に catch で拾う。
      const rasterCopy = new Uint8Array(pdfBytes.byteLength)
      rasterCopy.set(pdfBytes)
      const rasterized = await renderPdfPagesToPng(rasterCopy, {
        scale: THUMB_RASTER_SCALE,
      })
      const firstPage = rasterized.find((p) => p.page === 1) ?? rasterized[0]
      if (!firstPage) {
        await markFailed(supabase, templateId)
        return { ok: false, code: 'RENDER_FAILED' }
      }
      // 白塗り合成（boxes 無しならスキップして元 PNG を保持）。
      let composedBytes: Uint8Array = firstPage.pngBuffer
      if (hasWhiteout) {
        composedBytes = await compositeWhiteoutOnPng(firstPage, whiteoutBoxes as WhiteoutBox[])
      }
      // 固定テキスト合成（合成後の PNG を 1 ページ目として渡す）。
      if (hasFixedTexts) {
        const composedPage = { ...firstPage, pngBuffer: composedBytes }
        composedBytes = await compositeFixedTextsOnPng(
          composedPage,
          fixedTexts as FixedText[],
        )
      }
      thumbBytes = composedBytes
      ext = 'png'
      contentType = 'image/png'
    } else {
      // 従来経路（パス A / docx / 救済 API）。renderPdfToImages を無改変で使う。
      const totalPages = await getPdfNumPages(pdfBytes)
      const result = await renderPdfToImages({
        pdfBytes,
        totalPages,
        pageRange: { from: 1, to: 1 },
        requestedDpi: THUMB_DPI,
        format: THUMB_FORMAT,
        asZip: false,
        forceDpi: true,
      })
      thumbBytes = result.bytes
      ext = result.ext
      contentType = result.contentType
    }

    const cacheKey = `${familyId}/templates/${templateId}_${THUMB_DPI}_${THUMB_FORMAT}.${ext}`
    const thumbBlob = new Blob([thumbBytes.slice().buffer], {
      type: contentType,
    })
    // image_cache バケットは INSERT / SELECT / DELETE policy のみで UPDATE policy が無いため
    // `upsert: true` は 2 回目以降 RLS で弾かれて UPLOAD_FAILED になる
    //（白塗り編集→再保存→既存サムネ上書き時に再現する 500 の真因）。
    // remove() → upload(upsert:false) に分割し、DELETE policy + INSERT policy のみで成立させる。
    // remove は対象が無くてもエラーにならない（Storage 仕様）ので初回サムネ生成にも安全。
    await supabase.storage.from('image_cache').remove([cacheKey])
    const uploadRes = await supabase.storage
      .from('image_cache')
      .upload(cacheKey, thumbBlob, {
        contentType,
        upsert: false,
      })
    if (uploadRes.error) {
      await markFailed(supabase, templateId)
      return { ok: false, code: 'UPLOAD_FAILED' }
    }

    const { error: updErr } = await supabase
      .from('templates')
      .update({ thumbnail_path: cacheKey, thumbnail_status: 'ready' })
      .eq('id', templateId)
    if (updErr) {
      return { ok: false, code: 'DB_UPDATE_FAILED' }
    }

    return { ok: true, thumbnailPath: cacheKey }
  } catch (err) {
    console.error(
      `[generateTemplateThumbnail] failed templateId=${templateId}:`,
      err instanceof Error ? err.message : String(err),
    )
    await markFailed(supabase, templateId)
    return { ok: false, code: 'RENDER_FAILED' }
  }
}

async function markFailed(supabase: SupabaseClient, templateId: string) {
  await supabase
    .from('templates')
    .update({ thumbnail_status: 'failed' })
    .eq('id', templateId)
}
