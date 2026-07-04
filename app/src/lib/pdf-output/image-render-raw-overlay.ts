import JSZip from 'jszip'
import type { DowngradeDecision } from './dpi-downgrade'
import { renderPdfPagesToPng } from '@/lib/parsers/pdf/pdf-page-rasterizer'
import { compositeWhiteoutOnPng } from '@/lib/parsers/pdf/whiteout-composite'
import type { WhiteoutBox } from '@/lib/parsers/pdf/whiteout-pipeline'
import {
  fitTextInBox,
  FIT_HEIGHT_RATIO,
  type FittableFont,
  type FitTextPadding,
} from './fitting'
import { computeUniformFontSize, UNIFORM_PAD_TOP } from './uniform-size'
import { layoutFixedTextLines } from './fixedtext-draw'
import type { RenderPdfToImagesResult } from './image-renderer'
import {
  type MinuteOverlayField,
  OVERLAY_FONT_FAMILY_NAME,
  ensureNotoSansRegisteredForOverlay,
} from './image-render-overlay-shared'

export interface RenderRawPdfWithWhiteoutInput {
  /** raw PDF（templates_raw・source_path）のバイト列。健全＝A500 を踏まない元 PDF。 */
  rawPdfBytes: Uint8Array
  /** 白塗り座標（全ページ・pt・左上原点、templates.whiteout_boxes）。空でないこと前提（呼出側で判定）。 */
  whiteoutBoxes: WhiteoutBox[]
  /** 出力対象ページ範囲（1 始まり、inclusive）。省略時は全ページ。 */
  pageRange?: { from: number; to: number }
  /** 要求 dpi（72-300 clamp 済前提）。scale=dpi/72 でラスタライズする。 */
  requestedDpi: number
  /** 出力フォーマット（png のみ実質サポート、jpeg 指定時も白塗り合成は png で行い png 返却）。 */
  format: 'png' | 'jpeg'
  /** ZIP まとめ（複数ページ時に推奨）。 */
  asZip: boolean
}

/**
 * 白塗りテンプレ（whiteout_boxes あり）の render-image 経路を
 * A500 から構造的に守るヘルパー。
 *
 * 焼き込み済 `_blank.pdf` を rasterize すると pdf-lib 再保存による画像 XObject 変質で
 * `Value is none of these types String, Path` に落ちる（whiteout_richedit_A500_research §1）。
 * そこで bbox-editor / サムネ救済と同型の C-2 で退治する:
 *   健全な raw PDF を `renderPdfPagesToPng`(scale=dpi/72) でラスタライズし、各ページ PNG に
 *   `compositeWhiteoutOnPng` で白塗りを再合成してから返す（焼き込み PDF はラスタライズしない）。
 *
 * 🚨 個人情報死守: いずれかのページの再合成が例外で失敗したら、素の raw PNG を一切出力せず
 *   throw する（呼出側 route が 500 で握る＝漏洩より表示不能を選ぶ・research §5 / §2-3）。
 *
 * dpi 自動降格はこの経路では行わない（白塗り合成は worker 経路と別系で、サムネ/bbox-editor と
 * 同じ素直な scale 直結に揃える）。dpiDecision は要求 dpi をそのまま反映して返す。
 */
export async function renderRawPdfWithWhiteoutToImages(
  input: RenderRawPdfWithWhiteoutInput,
): Promise<RenderPdfToImagesResult> {
  // raw を全ページ scale=dpi/72 でラスタライズ（_blank.pdf は通さない＝A500 回避の本体）。
  const rasterCopy = new Uint8Array(input.rawPdfBytes.byteLength)
  rasterCopy.set(input.rawPdfBytes)
  const scale = input.requestedDpi / 72
  const rasterized = await renderPdfPagesToPng(rasterCopy, { scale })

  const totalPages = rasterized.length
  if (totalPages === 0) {
    throw new Error('IMAGE_RENDER_NO_PAGES')
  }
  const from = Math.max(1, input.pageRange?.from ?? 1)
  const to = Math.min(totalPages, input.pageRange?.to ?? totalPages)
  if (from > to) {
    throw new Error('IMAGE_RENDER_INVALID_RANGE')
  }

  // 要求範囲の各ページに白塗りを再合成する。
  // 合成が 1 ページでも失敗したら素の raw を出さず throw（個人情報死守）。
  const rendered: { page: number; imageBytes: Uint8Array }[] = []
  for (let page = from; page <= to; page++) {
    const target = rasterized.find((p) => p.page === page)
    if (!target) {
      throw new Error(`IMAGE_RENDER_PAGE_MISSING:${page}`)
    }
    // compositeWhiteoutOnPng は失敗時 throw（握り潰さない契約）。ここでも握らず上へ伝播させる。
    const pngBytes = await compositeWhiteoutOnPng(target, input.whiteoutBoxes)
    rendered.push({ page, imageBytes: pngBytes })
  }

  // 白塗り合成は常に PNG（jpeg 要求でも合成自体は PNG で行い png 返却＝漏洩経路を増やさない）。
  const dpiDecision: DowngradeDecision = {
    dpi: input.requestedDpi,
    downgraded: false,
    estimatedMs: 0,
  }

  if (input.asZip || rendered.length > 1) {
    const zip = new JSZip()
    for (const p of rendered) {
      const name = `page_${String(p.page).padStart(3, '0')}.png`
      zip.file(name, p.imageBytes)
    }
    const zipBytes = await zip.generateAsync({ type: 'uint8array' })
    return {
      bytes: zipBytes,
      contentType: 'application/zip',
      ext: 'zip',
      dpiDecision,
      renderedPages: rendered.length,
      warnings: [],
    }
  }

  const single = rendered[0]
  return {
    bytes: single.imageBytes,
    contentType: 'image/png',
    ext: 'png',
    dpiDecision,
    renderedPages: 1,
    warnings: [],
  }
}

// =============================================================================
// 案 A（minutes_overlay_a500_research §4）: minutes 側 render-image の raw 起点経路
// =============================================================================
//
// 真因: overlay 済 `_blank.pdf`（pdf-lib 二段保存）の rasterize で画像 XObject 変質
//   → pdfjs/embedPng 例外 → render-image 500（whiteout_richedit_A500_research §1）。
//
// 退治: 出力 PDF（PDF/Word ダウンロード）は overlay-generator 経路を温存し、画像化経路
//   だけ「raw を rasterize → 白塗り PNG 再合成 → 固定テキスト/本文を canvas drawText
//   で焼く」純画像合成に差し替える。`_blank.pdf` を一切 rasterize しないため、画像
//   XObject 変質の経路を構造的に踏まない。
//
// 漏洩死守: 合成失敗時は throw（route 側 catch で 500）。素の raw PNG は一切返さない。
//   中間 PNG はメモリ内のみ・Storage 書き出しなし（compositeWhiteoutOnPng 契約を踏襲）。

export interface RenderMinuteRawWithOverlayInput {
  /** raw PDF（templates_raw・source_path）のバイト列。健全 = A500 を踏まない元 PDF。 */
  rawPdfBytes: Uint8Array
  /** 白塗り座標（全ページ・pt・左上原点、templates.whiteout_boxes）。0 件可。 */
  whiteoutBoxes: WhiteoutBox[]
  /**
   * overlay 対象 field 群（fields + fixedTexts を `fixedTextToPseudoFieldsByLines`
   * 展開で平坦化したもの。bbox は左上原点 pt・page 1 始まり）。
   * 各要素は overlay-generator が呼ぶ fitTextInBox と同じ規約で配置される。
   */
  overlayFields: MinuteOverlayField[]
  /** 出力対象ページ範囲（1 始まり、inclusive）。省略時は全ページ。 */
  pageRange?: { from: number; to: number }
  /** 要求 dpi（72-300 clamp 済前提）。scale=dpi/72 でラスタライズする。 */
  requestedDpi: number
  /** 出力フォーマット（実体は PNG。jpeg 要求でも合成は PNG・漏洩経路を増やさない）。 */
  format: 'png' | 'jpeg'
  /** ZIP まとめ（複数ページ時に推奨）。 */
  asZip: boolean
  /**
   * 文字サイズ自動統一の適用対象 field name 集合。
   *
   * overlay-generator.OverlayInput.uniformTargetNames と同義・同経路。指定された name の
   * overlayField は fitTextInBox 呼出前に font.size を記入欄統一サイズへ差し替えてから焼く。
   * 母集団も「この集合に属する記入欄 field のみ」。固定テキスト疑似 field は含めない。
   * 未指定なら従来どおり uniform 無効（後方互換）。
   *
   * 🚨 overlay PDF（overlay-generator）と画像化プレビュー（本関数）で **同じ uniform** に
   * なるよう、両経路は同一の記入欄 field 母集団 + 同一 computeUniformFontSize を通すこと。
   */
  uniformTargetNames?: Set<string>
  /**
   * 🔴 固定テキスト WYSIWYG 修正（2026-06-08・本対応）の対象 field name 集合。
   *
   * overlay-generator.OverlayInput.fixedTextNames と同義・同経路。固定テキスト疑似 field
   * （fixedTextToPseudoFieldsByLines 展開）は **fitTextInBox を一切通さず**、共有純関数
   * `layoutFixedTextLines`（top 揃え・幅オーバー縮小・truncate しない）＋ canvas drawText
   * （`textBaseline='top'`）で直描きする（②サムネ・①編集 canvas と同一式＝WYSIWYG）。
   * 記入欄は従来どおり fitTextInBox + uniform 経路を維持する（経路別・回帰なし）。
   *
   * 🚨 overlay PDF（overlay-generator）と本関数で固定テキスト出力が一致するよう、両経路へ
   *   同一の固定テキスト疑似 field 名集合を渡すこと。未指定なら固定テキスト 0 件扱い（後方互換）。
   */
  fixedTextNames?: Set<string>
  /**
   * 全体の文字サイズ手動上書き値（pt）。
   *
   * 指定時は `computeUniformFontSize`（snap 含む自動算出）を呼ばずに本値を uniform として
   * 採用する（手動 > 自動）。クランプは呼出側で RANGE 内に閉じてから渡す前提。
   */
  uniformOverridePt?: number
}

/**
 * 案 A 本体: raw PDF → ラスタライズ → 白塗り再合成 → overlay 本文を画像上に drawText
 * で焼き込み → PNG/ZIP を返す。
 *
 * フィッティング（フォントサイズ 2 分探索 / 改行 / 末尾省略）の規約は overlay-generator
 * と完全同一の `fitTextInBox` を共用する。drawText 座標は overlay-generator §8-3 と
 * 同じ算式（PDF 左下原点・baseline ベース）を pt → px 線形変換した上で canvas の
 * `textBaseline = 'alphabetic'` に合わせて配置する。
 *
 * 🚨 個人情報死守: 白塗り合成・drawText 合成のいずれかが失敗した場合は throw する。
 *   route 側 catch が 500 を返し、素の raw PNG は signedUrl 発行されない
 *   （research §5 / templates 側 render-image と同一契約）。
 */
export async function renderMinuteRawWithOverlayToImages(
  input: RenderMinuteRawWithOverlayInput,
): Promise<RenderPdfToImagesResult> {
  // 1. raw を全ページ scale=dpi/72 でラスタライズ（_blank.pdf は通さない＝A500 回避の本体）。
  const rasterCopy = new Uint8Array(input.rawPdfBytes.byteLength)
  rasterCopy.set(input.rawPdfBytes)
  const scale = input.requestedDpi / 72
  const rasterized = await renderPdfPagesToPng(rasterCopy, { scale })

  const totalPages = rasterized.length
  if (totalPages === 0) {
    throw new Error('IMAGE_RENDER_NO_PAGES')
  }
  const from = Math.max(1, input.pageRange?.from ?? 1)
  const to = Math.min(totalPages, input.pageRange?.to ?? totalPages)
  if (from > to) {
    throw new Error('IMAGE_RENDER_INVALID_RANGE')
  }

  // 2. fitTextInBox 用の font を 1 度だけ準備（_blank.pdf を load しない新規 PDFDocument）。
  //    overlay-generator と同一の embedNotoSansCJKjp ヘルパを呼ぶことで widthOfTextAtSize /
  //    heightAtSize のメトリクスを一致させる。生成した PDFDocument は捨てる（save しない・
  //    画像 XObject 変質経路を通さない）。
  const { PDFDocument } = await import('pdf-lib')
  const metricsDoc = await PDFDocument.create()
  const { embedNotoSansCJKjp } = await import('./font-loader')
  const font = (await embedNotoSansCJKjp(metricsDoc, {
    subset: true,
  })) as FittableFont

  // 2-b. 案 C（段階 1・§4-4 第 1 案）: 記入欄統一サイズを 1 度だけ算出。
  //   母集団は uniformTargetNames に属する記入欄 field のみ（固定テキスト疑似 field は除外）。
  //   overlay-generator と同一の computeUniformFontSize + 同一 font メトリクスを通すことで、
  //   overlay PDF と画像化プレビューの uniform を一致させる（見た目一致要件）。
  const uniformTargetNames = input.uniformTargetNames
  let uniformSize: number | null = null
  if (uniformTargetNames && uniformTargetNames.size > 0) {
    const uniformFields = input.overlayFields
      .filter((of) => uniformTargetNames.has(of.field.name))
      .map((of) => of.field)
    if (uniformFields.length > 0) {
      // 手動上書き値があれば snap を含む自動算出をスキップし、本値を採用する
      //   （呼出側で RANGE クランプ済の前提）。
      if (typeof input.uniformOverridePt === 'number') {
        uniformSize = input.uniformOverridePt
      } else {
        // overlay-generator と論理整合: 個人スタイル padding を field 名 → padding の map に
        //   集約して computeUniformFontSize に渡す（overlay-generator §96 と同形）。
        //   現状 route は userStylePadding 未設定（全 undefined）のため結果は不変＝実害ゼロ。
        //   将来 route が userStylePadding を設定した際に PDF 出力と uniform 母集団が自動整合する。
        const uniformPadding: Record<string, FitTextPadding> = {}
        for (const of of input.overlayFields) {
          if (uniformTargetNames.has(of.field.name) && of.userStylePadding) {
            uniformPadding[of.field.name] = of.userStylePadding
          }
        }
        const paddingArg =
          Object.keys(uniformPadding).length > 0 ? uniformPadding : undefined
        // 改善①（minutes_kinput_ux3_design_2026-06-10 §1）: 同ページ固定テキストの font.size 群を
        //   computeUniformFontSize に渡す。fixedTextNames に属する overlayField の font.size を集約。
        //   PDF 経路（overlay-generator）と同一の集合・閾値で snap させ 3 経路一致を担保する。
        const fixedTextSizesPt: number[] = []
        if (input.fixedTextNames && input.fixedTextNames.size > 0) {
          for (const of of input.overlayFields) {
            if (input.fixedTextNames.has(of.field.name)) {
              fixedTextSizesPt.push(of.field.font.size)
            }
          }
        }
        uniformSize = computeUniformFontSize(
          uniformFields,
          font,
          paddingArg,
          undefined,
          fixedTextSizesPt,
        )
      }
    }
  }

  // 3. @napi-rs/canvas に NotoSansJP を登録（fixedtext-composite と同型キャッシュ）。
  await ensureNotoSansRegisteredForOverlay()
  const { loadImage, createCanvas } = await import('@napi-rs/canvas')

  // 4. 各ページごとに「白塗り合成 → overlay drawText」を直列実行。
  const rendered: { page: number; imageBytes: Uint8Array }[] = []
  for (let page = from; page <= to; page++) {
    const target = rasterized.find((p) => p.page === page)
    if (!target) {
      throw new Error(`IMAGE_RENDER_PAGE_MISSING:${page}`)
    }

    // 4-a. 白塗り再合成（失敗時は throw → 素の raw を出さず 500・個人情報死守）。
    const whiteoutPng = await compositeWhiteoutOnPng(target, input.whiteoutBoxes)

    // 4-b. 当該ページ向け overlay field 抽出。0 件なら drawText を skip し白塗り版をそのまま採用。
    const pageFields = input.overlayFields.filter(
      (of) => of.field.bbox.page === page,
    )
    if (pageFields.length === 0) {
      rendered.push({ page, imageBytes: whiteoutPng })
      continue
    }

    // 4-c. canvas に背景描画 → fitTextInBox で得た fontSize / lines を pt → px 変換で焼く。
    const pixelW = target.pixelWidth
    const pixelH = target.pixelHeight
    const sx = pixelW / target.pagePtSize.width
    const sy = pixelH / target.pagePtSize.height
    const img = await loadImage(whiteoutPng)
    const canvas = createCanvas(pixelW, pixelH)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0, pixelW, pixelH)
    ctx.fillStyle = '#000000'

    for (const of of pageFields) {
      const { value, userStylePadding } = of
      if (value === undefined || value === null) continue
      const text = String(value)
      if (text.length === 0) continue

      // 固定テキスト分岐: 固定テキスト疑似 field は fitTextInBox を一切通さず、
      //   共有純関数 layoutFixedTextLines（top 揃え・幅オーバー縮小・truncate しない）+
      //   canvas drawText（textBaseline='top'）で直描きする（サムネと同一式）。
      //   px 空間で計算し、measure に canvas measureText を注入（ascent 補正不要）。
      const isFixedText = input.fixedTextNames?.has(of.field.name) ?? false
      if (isFixedText) {
        const fontPx = Math.max(1, of.field.font.size * sy)
        ctx.textBaseline = 'top'
        const measure = (line: string, size: number): number => {
          ctx.font = `${size}px "${OVERLAY_FONT_FAMILY_NAME}"`
          return ctx.measureText(line).width
        }
        // bbox 縦横中央配置（2026-06-14）: 縦中央計算に h（px 換算）も渡す。
        const drawLines = layoutFixedTextLines(
          text,
          {
            x: of.field.bbox.x * sx,
            y: of.field.bbox.y * sy,
            w: of.field.bbox.w * sx,
            h: of.field.bbox.h * sy,
          },
          fontPx,
          measure,
        )
        for (const dl of drawLines) {
          ctx.font = `${dl.drawSize}px "${OVERLAY_FONT_FAMILY_NAME}"`
          ctx.fillText(dl.text, dl.xPt, dl.topYPt)
        }
        continue
      }

      // 記入欄: overlay-generator は PDF 左下原点 baseline で配置する。canvas は textBaseline=
      // 'alphabetic' = フォント baseline。同じ「baseline 位置」を pt → px 変換した y で配置すれば
      // overlay PDF と同位置に近似できる（フォントメトリクス自体は同一 OTF）。
      ctx.textBaseline = 'alphabetic'
      // uniform 対象なら font.size を差し替えた派生 field を使う（§4-4 第 1 案・無改修）。
      const isUniformTarget =
        uniformSize !== null && (uniformTargetNames?.has(of.field.name) ?? false)
      const field = isUniformTarget
        ? { ...of.field, font: { ...of.field.font, size: uniformSize as number } }
        : of.field
      // 🔴 三次 FB（2026-06-08）: 記入欄（uniform 対象）だけ高さ判定/行送り/baseline を
      //   FIT_HEIGHT_RATIO に揃える。非対象は heightRatio 未指定＝従来 heightAtSize。
      //   overlay-generator §8-3 と完全同一の分岐で PDF と画像の見た目を一致させる。
      const heightRatio = isUniformTarget ? FIT_HEIGHT_RATIO : undefined
      // 🔴 記入欄 uniform は lockSize=true で uniform を最終サイズに固定（高さ縮小抑止）。
      //   固定テキストは上で別分岐済み（uniform 専用機構）。
      const lockSize = isUniformTarget

      const fit = fitTextInBox(text, field, font, userStylePadding, heightRatio, {
        lockSize,
      })
      const padding = userStylePadding ?? field.padding
      const fontHeightPt =
        heightRatio === undefined
          ? font.heightAtSize(fit.fontSize)
          : fit.fontSize * heightRatio
      // overlay-generator §8-3 と同一の startBaselineY 計算（PDF 左下原点）。
      //   startBaselineY_pt = pageHeight - bbox.y - topPad - fontHeight
      // これを「PDF 上端からの baseline 距離 pt」に置き換えると:
      //   baselineFromTop_pt = pageHeight - startBaselineY_pt = bbox.y + topPad + fontHeight
      // overlay-generator と同一分岐。uniform 対象は上端揃え padding.top を
      //   UNIFORM_PAD_TOP(=0) に揃え、上端いっぱいから始める。
      //   非 uniform（固定テキスト等）は従来どおり field.padding.top を使う。
      const topPad = isUniformTarget ? UNIFORM_PAD_TOP : padding.top
      const baselineFromTopPt =
        field.bbox.y + topPad + fontHeightPt
      const lineHeightPt = fontHeightPt * 1.2
      const startX_px = (field.bbox.x + padding.left) * sx
      const fontSizePx = fit.fontSize * sy
      // canvas 用 font 指定（NotoSansJP は overlay 用 family 名で登録済）。
      ctx.font = `${fontSizePx}px "${OVERLAY_FONT_FAMILY_NAME}"`

      fit.lines.forEach((line, i) => {
        const baselineY_px = (baselineFromTopPt + i * lineHeightPt) * sy
        ctx.fillText(line, startX_px, baselineY_px)
      })
    }

    rendered.push({ page, imageBytes: canvas.toBuffer('image/png') })
  }

  const dpiDecision: DowngradeDecision = {
    dpi: input.requestedDpi,
    downgraded: false,
    estimatedMs: 0,
  }

  if (input.asZip || rendered.length > 1) {
    const zip = new JSZip()
    for (const p of rendered) {
      const name = `page_${String(p.page).padStart(3, '0')}.png`
      zip.file(name, p.imageBytes)
    }
    const zipBytes = await zip.generateAsync({ type: 'uint8array' })
    return {
      bytes: zipBytes,
      contentType: 'application/zip',
      ext: 'zip',
      dpiDecision,
      renderedPages: rendered.length,
      warnings: [],
    }
  }

  const single = rendered[0]
  return {
    bytes: single.imageBytes,
    contentType: 'image/png',
    ext: 'png',
    dpiDecision,
    renderedPages: 1,
    warnings: [],
  }
}
