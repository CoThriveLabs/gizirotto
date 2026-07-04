import { renderMinuteBuiltinBgWithOverlayToImages } from '@/lib/pdf-output/image-renderer'
import { type MinuteOverlayField } from '@/lib/pdf-output/image-render-overlay-shared'
import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'
import { flattenContent } from '@/lib/utils/minutes-output'
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
import type { TplRow, RenderSourceResult } from './render-source-types'

type RenderResult = Extract<RenderSourceResult, { ok: true }>['result']

export interface BuiltinBgRenderParams {
  template: TplRow
  tplFields: PdfField[]
  bboxOverrides: unknown
  contentJson: unknown
  minutesId: string
  dpi: number
  format: 'png' | 'jpeg'
  raw: boolean
}

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
export async function resolveBuiltinBgRender(
  params: BuiltinBgRenderParams,
): Promise<RenderSourceResult> {
  const { template, tplFields, bboxOverrides, contentJson, minutesId, dpi, format, raw } = params

  try {
    let result: RenderResult
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
      const dbOverrides = parseFieldOverrides(bboxOverrides)
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

      const valuesMap = flattenContent(contentJson)
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
    return { ok: true, result }
  } catch (err) {
    return { ok: false, response: errorResponse('IMAGE_RENDER_FAILED', 500, err) }
  }
}
