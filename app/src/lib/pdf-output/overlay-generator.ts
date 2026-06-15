/**
 * PdfOverlayGenerator — 「PDF レイアウト保持出力」の本体。
 *
 * `templates_processed/{template_id}_blank.pdf` を起点に、各 field の bbox に
 * AI 生成テキストをフィッティング 3 段適用して `pdf-lib.drawText` で配置する。
 *
 * 処理フロー:
 *   1. blank.pdf を pdf-lib で開く（罫線・背景はビットマップとして 100% 保持）
 *   2. Noto Sans CJK JP を embedFont（subset）
 *   3. 各 field について fitTextInBox で 3 段フィッティング
 *   4. pdf-lib.drawText で配置（座標は PDF 左下原点に変換）
 *   5. warnings 集計（フィッティング 3 段失敗 = overflow を UI 警告へ）
 *
 * 重要:
 *   - 罫線・背景は **再描画しない**（オーバーレイ方式の最大メリット、原本 100% 保持）
 *   - フィッティング順序厳守: フォントサイズ 2 分探索 → 改行 → 末尾省略
 *   - 3 段すべて失敗時は warnings に追加（UI 側で手動調整誘導）
 */

import type { PdfField } from '../ai/schemas/pdf-field-schema'
import {
  fitTextInBox,
  FIT_HEIGHT_RATIO,
  type FittableFont,
  type FitResult,
  type FitTextPadding,
} from './fitting'
import { computeUniformFontSize, UNIFORM_PAD_TOP } from './uniform-size'
import { layoutFixedTextLines } from './fixedtext-draw'

export interface OverlayInput {
  /** 入力 blank.pdf のバイト列（templates_processed/_blank.pdf） */
  blankPdfBytes: Uint8Array
  /** templates.fields（PdfField[]、bbox 込み） */
  fields: PdfField[]
  /** field_name → 出力テキスト map（プロンプト結果） */
  fieldValues: Record<string, string>
  /** 個人スタイル padding（field_name → padding）。null 可 */
  userStylePadding?: Record<string, FitTextPadding>
  /**
   * 文字サイズ自動統一の適用対象 field name 集合。
   *
   * - 指定された name の field は、fitTextInBox 呼出前に font.size を「記入欄統一サイズ
   *   （computeUniformFontSize の結果）」へ差し替えてから渡す。
   * - 母集団も「この集合に属する記入欄 field のみ」。固定テキスト疑似 field（テンプレ固有
   *   サイズを保つべきもの）は集合に入れないことで影響を受けない。
   * - 未指定なら uniform を一切適用しない（後方互換）。
   */
  uniformTargetNames?: Set<string>
  /**
   * 固定テキスト WYSIWYG 対象 field name 集合。
   *
   * 固定テキスト疑似 field（fixedTextToPseudoFieldsByLines 展開）は font.size を明示保存し、
   * テンプレ編集 canvas／サムネは保存サイズで top 揃え描画する。fitTextInBox を通すと
   * padding 二重取りや heightAtSize baseline ずれが露呈する。
   *
   * この集合に属する field は fitTextInBox を一切通さず、共有純関数 `layoutFixedTextLines`
   * （top 揃え・幅オーバー縮小・truncate しない）+ pdf-lib drawText で直描きする
   * （サムネ・編集 canvas と同一式＝WYSIWYG）。記入欄は従来どおり fitTextInBox + uniform 経路。
   *
   * 未指定なら固定テキストは 0 件扱い（後方互換）。
   */
  fixedTextNames?: Set<string>
  /**
   * 全体の文字サイズ手動上書き値（pt）。
   *
   * 指定時は `computeUniformFontSize`（snap 含む自動算出）を呼ばずに本値を uniform として
   * 採用する（手動 > 自動）。クランプは呼出側で RANGE 内に閉じてから渡す前提。未指定なら
   * 従来どおり computeUniformFontSize を呼ぶ（後方互換）。
   */
  uniformOverridePt?: number
}

export interface OverlayWarning {
  fieldName: string
  /** fitTextInBox の warning */
  warning: FitResult['warning']
  /** 元テキスト（UI 警告で「この項目が…」と表示するため） */
  originalText: string
  /** 末尾省略後のテキスト（truncated / overflow 時のみ） */
  truncatedText?: string
}

export interface OverlayOutput {
  /** 生成された PDF のバイト列 */
  pdfBytes: Uint8Array
  /** フィッティングで縮小 / 改行 / 省略 / オーバーフローが発生した警告群 */
  warnings: OverlayWarning[]
}

/**
 * 固定テキスト top→baseline 変換用の ascent（pt）を pdf-lib の font メトリクスから実測する
 * （設計書 Q-2・経験係数を避ける）。
 *
 * canvas `textBaseline='top'` は「文字上端を y に合わせる」描画。pdf-lib は左下原点 baseline の
 * ため、文字上端を bbox.y に合わせるには baseline を `ascent` ぶん下げる必要がある。
 * pdf-lib CustomFontEmbedder は `font.embedder.font.ascent`（フォント単位）と
 * `font.embedder.scale = 1000/unitsPerEm` を持ち、`heightAtSize` も `ascent*scale/1000*size` を
 * 上端として使う。同じ式で ascent(pt) = `ascent*scale/1000*size` を実測する。
 * メトリクスを取れない異常時は `heightAtSize(size)`（フォント全高）を上端目安にフォールバック。
 */
function fixedTextAscentAtSize(font: FittableFont, size: number): number {
  const embedder = (font as unknown as {
    embedder?: {
      scale?: number
      font?: { ascent?: number; bbox?: { maxY?: number } }
    }
  }).embedder
  const inner = embedder?.font
  const scale = embedder?.scale
  const ascentUnits = inner?.ascent ?? inner?.bbox?.maxY
  if (
    typeof ascentUnits === 'number' &&
    typeof scale === 'number' &&
    ascentUnits > 0 &&
    scale > 0
  ) {
    return (ascentUnits * scale * size) / 1000
  }
  // フォールバック: メトリクス未取得時はフォント全高を上端目安に（下ずれ回避優先）。
  return font.heightAtSize(size)
}

/**
 * blank.pdf に AI 生成テキストをオーバーレイし、原本レイアウトを保持した
 * 完成版 PDF を返す。
 *
 * @param input.blankPdfBytes  原本 blank.pdf バイト列
 * @param input.fields         templates.fields
 * @param input.fieldValues    field name → 出力テキスト
 * @param input.userStylePadding Phase 4 個人スタイル padding（optional）
 */
export async function generateOverlayPdf(input: OverlayInput): Promise<OverlayOutput> {
  if (!input.blankPdfBytes || input.blankPdfBytes.byteLength === 0) {
    throw new Error('OVERLAY_BLANK_PDF_EMPTY')
  }
  if (!input.fields || input.fields.length === 0) {
    throw new Error('OVERLAY_FIELDS_EMPTY')
  }

  const { PDFDocument, rgb } = await import('pdf-lib')
  const pdf = await PDFDocument.load(input.blankPdfBytes)

  const { embedNotoSansCJKjp } = await import('./font-loader')
  const font = (await embedNotoSansCJKjp(pdf, { subset: true })) as FittableFont & {
    // pdf-lib drawText が要求する PDFFont 互換 brand を構造的に持つ
  }

  const pages = pdf.getPages()
  const warnings: OverlayWarning[] = []

  // 案 C（段階 1・§4-4 第 1 案）: 記入欄統一サイズを 1 度だけ算出。
  //   母集団は uniformTargetNames に属する記入欄 field のみ（固定テキストは除外）。
  //   fitTextInBox は無改修のまま、対象 field の font.size を uniform で差し替えた
  //   派生 field を渡す（既定サイズで枠に入れば縮めない＝そのまま uniform が採用される）。
  const uniformTargetNames = input.uniformTargetNames
  let uniformSize: number | null = null
  if (uniformTargetNames && uniformTargetNames.size > 0) {
    const uniformFields = input.fields.filter((f) =>
      uniformTargetNames.has(f.name),
    )
    if (uniformFields.length > 0) {
      // 手動上書き値があれば snap を含む自動算出をスキップし、本値を採用する
      //   （呼出側で RANGE クランプ済の前提）。
      if (typeof input.uniformOverridePt === 'number') {
        uniformSize = input.uniformOverridePt
      } else {
        // 同ページ固定テキストの font.size 群を computeUniformFontSize に渡し、
        //   ±1.0pt 以内なら最頻値へスナップさせる（外れ値除外は uniform-size.ts 側）。
        //   fixedTextNames は呼出側（regenerate-minute-pdf.ts）で疑似 field 名集合として渡される。
        //   未指定なら空配列＝snap 無効＝後方互換。
        const fixedTextSizesPt: number[] = []
        if (input.fixedTextNames && input.fixedTextNames.size > 0) {
          for (const f of input.fields) {
            if (input.fixedTextNames.has(f.name)) {
              fixedTextSizesPt.push(f.font.size)
            }
          }
        }
        uniformSize = computeUniformFontSize(
          uniformFields,
          font,
          input.userStylePadding,
          undefined,
          fixedTextSizesPt,
        )
      }
    }
  }

  for (const baseField of input.fields) {
    const value = input.fieldValues[baseField.name]
    if (value === undefined || value === null) continue
    const text = String(value)
    if (text.length === 0) continue

    // 配置先ページ（fit/描画の前にチェック、無駄な計算回避）
    const pageIndex = baseField.bbox.page - 1
    if (pageIndex < 0 || pageIndex >= pages.length) {
      // 範囲外（あり得ないが防御）→ skip
      warnings.push({
        fieldName: baseField.name,
        warning: 'overflow',
        originalText: text,
      })
      continue
    }
    const page = pages[pageIndex]

    // 固定テキスト分岐: 固定テキスト疑似 field は fitTextInBox を一切通さず、
    //   共有純関数 layoutFixedTextLines（top 揃え・幅オーバー縮小・truncate しない）+
    //   pdf-lib drawText で直描きする（サムネ・編集 canvas と同一式）。
    //   pt 空間で計算し、measure に font.widthOfTextAtSize を注入。pdf-lib は左下原点 baseline の
    //   ため top→baseline 変換（ascent 実測補正・Q-2）を入れる。
    const isFixedText = input.fixedTextNames?.has(baseField.name) ?? false
    if (isFixedText) {
      const fontSize = baseField.font.size
      // bbox 縦横中央配置（2026-06-14）: pt 空間なので bbox をそのまま渡す（h 含む）。
      const drawLines = layoutFixedTextLines(
        text,
        {
          x: baseField.bbox.x,
          y: baseField.bbox.y,
          w: baseField.bbox.w,
          h: baseField.bbox.h,
        },
        fontSize,
        (line, size) => font.widthOfTextAtSize(line, size),
      )
      const pageHeight = page.getHeight()
      for (const dl of drawLines) {
        const ascent = fixedTextAscentAtSize(font, dl.drawSize)
        // 文字上端を topYPt に合わせる: baseline = pageHeight - (topYPt + ascent)。
        const baselineY = pageHeight - (dl.topYPt + ascent)
        page.drawText(dl.text, {
          x: dl.xPt,
          y: baselineY,
          size: dl.drawSize,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          font: font as any,
          color: rgb(0, 0, 0),
        })
      }
      continue
    }

    // uniform 対象なら font.size を差し替えた派生 field を使う（§4-4 第 1 案）。
    const isUniformTarget =
      uniformSize !== null && (uniformTargetNames?.has(baseField.name) ?? false)
    const field = isUniformTarget
      ? { ...baseField, font: { ...baseField.font, size: uniformSize as number } }
      : baseField
    // 🔴 三次 FB（2026-06-08）: 記入欄（uniform 対象）だけ高さ判定/行送り/baseline を
    //   FIT_HEIGHT_RATIO（漢字 em 基準=1.0）に揃える。非対象 field は heightRatio 未指定＝
    //   従来どおり font.heightAtSize で完全後方互換（回帰なし）。
    const heightRatio = isUniformTarget ? FIT_HEIGHT_RATIO : undefined
    // 🔴 記入欄 uniform は lockSize=true で uniform を最終サイズに固定する（高さ起因の縮小抑止）。
    //   固定テキストは上で別分岐済みのため、ここに来る固定テキストは無い（uniform 専用機構）。
    const lockSize = isUniformTarget

    // 個人スタイル padding 上書き
    const userStylePadding = input.userStylePadding?.[field.name]

    // フィッティング 3 段適用（記入欄は FIT_HEIGHT_RATIO で高さ判定統一）。
    const fit = fitTextInBox(text, field, font, userStylePadding, heightRatio, {
      lockSize,
    })

    if (fit.warning !== 'none') {
      warnings.push({
        fieldName: field.name,
        warning: fit.warning,
        originalText: text,
        truncatedText: fit.truncated ? fit.lines.join('') : undefined,
      })
    }
    const padding = userStylePadding ?? field.padding

    // §8-3 drawText 配置時の座標計算
    // - bbox.y はアプリ内部表現（左上原点）
    // - pdf-lib drawText の y は左下原点 + baseline
    const pageHeight = page.getHeight()
    const startX = field.bbox.x + padding.left
    // text 上端を bbox.y + topPad に揃えるため、baseline は
    //   pageHeight - (bbox.y + topPad + fontHeight)
    // fontHeight は fit 高さ判定と同係数で算出する（記入欄は fit.fontSize * FIT_HEIGHT_RATIO・
    //   漢字 em 基準）。fit 判定と baseline 用の文字高が食い違うと縦位置がずれるため同係数で揃える。
    // uniform 対象は上端揃え padding.top を uniform 算出と同じ UNIFORM_PAD_TOP(=0) に揃える。
    //   揃えないと uniform を上げても baseline が field.padding.top 分だけ下がり最小欄の
    //   上余白が残る。非 uniform（固定テキスト等）は従来どおり field.padding.top を使う。
    const topPad = isUniformTarget ? UNIFORM_PAD_TOP : padding.top
    const fontHeight =
      heightRatio === undefined
        ? font.heightAtSize(fit.fontSize)
        : fit.fontSize * heightRatio
    const startBaselineY = pageHeight - field.bbox.y - topPad - fontHeight
    const lineHeight = fontHeight * 1.2 // 行間 1.2 倍

    fit.lines.forEach((line, i) => {
      page.drawText(line, {
        x: startX,
        y: startBaselineY - i * lineHeight,
        size: fit.fontSize,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        font: font as any,
        color: rgb(0, 0, 0),
      })
    })
  }

  const pdfBytes = await pdf.save()
  return { pdfBytes, warnings }
}
