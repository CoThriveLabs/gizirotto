/**
 * PDF → 画像化レンダラー — 経路共通の結果型 + builtin テンプレ overlay 焼込み経路。
 *
 * worker 隔離経路（factory 経由の pdfjs-render-worker spawn）は image-render-worker.ts、
 * raw PDF overlay 経路（白塗り再合成 + overlay drawText）は image-render-raw-overlay.ts、
 * 両経路が共有する型 + font 登録ヘルパは image-render-overlay-shared.ts に分割されている。
 */
import type { DowngradeDecision } from './dpi-downgrade'
import {
  fitTextInBox,
  FIT_HEIGHT_RATIO,
  type FittableFont,
  type FitTextPadding,
} from './fitting'
import { computeUniformFontSize, UNIFORM_PAD_TOP } from './uniform-size'
import { layoutFixedTextLines } from './fixedtext-draw'
import {
  type MinuteOverlayField,
  OVERLAY_FONT_FAMILY_NAME,
  ensureNotoSansRegisteredForOverlay,
} from './image-render-overlay-shared'

export interface RenderPdfToImagesInput {
  /** 入力 PDF バイト列（呼出側でコピー渡し推奨、worker は構造化複製で受ける）*/
  pdfBytes: Uint8Array
  /** 総ページ数（dpi 自動降格の見積に使用、不明なら 1）*/
  totalPages: number
  /** 出力対象ページ範囲（1 始まり、inclusive）。省略時は [1..totalPages] */
  pageRange?: { from: number; to: number }
  /** 要求 dpi（72-300 clamp 済前提）*/
  requestedDpi: number
  /** 出力フォーマット */
  format: 'png' | 'jpeg'
  /** ZIP まとめ（複数ページ時に推奨）*/
  asZip: boolean
  /** dpi 自動降格無効化（§3-10-d 脱出ハッチ）*/
  forceDpi?: boolean
}

export interface ImageRenderWarning {
  type: 'dpi_auto_downgrade' | 'over_threshold_min_dpi'
  message: string
  details: Record<string, unknown>
}

export interface RenderPdfToImagesResult {
  /** 出力バイト列（asZip=true なら ZIP、false なら最初の 1 ページ画像）*/
  bytes: Uint8Array
  /** Content-Type */
  contentType: string
  /** ファイル拡張子（zip / png / jpg）*/
  ext: string
  /** dpi 決定情報（UI トースト用）*/
  dpiDecision: DowngradeDecision
  /** 実レンダリング済ページ数 */
  renderedPages: number
  warnings: ImageRenderWarning[]
}

// =============================================================================
// builtin テンプレ詳細画面の overlay 焼込み経路:
//   builtin テンプレ（family_id=null・source_path=null）の詳細画面 render-image 経路は
//   bg.png（テンプレ枠のみ・値セル空白）をそのまま返していたため、ユーザー入力 content_json が
//   詳細画面で一切焼き込まれない構造的欠陥があった。AdjustView は canvas 動的合成で値が
//   見えるが、詳細画面の <img> はサーバ生成 PNG しか持たないので値が消えて見える。
//
//   修正: bg.png を背景に、`renderMinuteRawWithOverlayToImages` と同型の overlay drawText を
//   canvas で焼く新エクスポート関数 `renderMinuteBuiltinBgWithOverlayToImages` を追加する。
//   raw PDF 経路（既存）と独立した実装でコード重複は許容するが、drawText ステップは
//   §8-3 同型（uniform / fixed text / fitTextInBox / baseline 計算）を完全踏襲し、PDF
//   出力（regenerate-minute-pdf の simple-pdf 経路は別）/ AdjustView canvas / サムネと
//   見た目の式整合を保つ。
//
//   user テンプレ経路（source_path あり = raw PDF 経路）には一切触らない＝副作用ゼロ。
// =============================================================================

export interface RenderMinuteBuiltinBgWithOverlayInput {
  /** builtin テンプレ背景 PNG（public/builtin-templates/{slug}.bg.png）バイト列。 */
  bgPngBytes: Uint8Array
  /** 背景 PNG が表現する PDF ページの pt サイズ（builtin bbox.json の `page.{width,height}`）。 */
  pagePtSize: { width: number; height: number }
  /** overlay 対象 field 群（raw 経路と同じ構造・bbox は左上原点 pt・page=1 固定）。 */
  overlayFields: MinuteOverlayField[]
  /** 出力 dpi（builtin は再 rasterize しないため px 寸法は背景 PNG 実寸そのまま使う・引数は API 互換用）。 */
  requestedDpi: number
  /** 出力フォーマット（builtin は常に PNG 1 枚返し・zip 非対応・引数は API 互換用）。 */
  format: 'png' | 'jpeg'
  /** uniform / fixed text の挙動は raw 経路と完全同型（呼出側で同じ集合を渡すこと）。 */
  uniformTargetNames?: Set<string>
  fixedTextNames?: Set<string>
  uniformOverridePt?: number
}

/**
 * builtin テンプレ用の bg.png + overlay 合成。
 *
 * `renderMinuteRawWithOverlayToImages` のステップ 3〜4 と式同型の drawText パイプラインを
 * 持つが、入力が **PDF ではなく事前生成済の bg.png** である点だけが異なる。
 *
 * 流れ:
 *   1. bg.png を loadImage し、その実 px 寸法を canvas キャンバスにそのまま採用。
 *   2. `pagePtSize.{width,height}` を基準に sx/sy 変換係数を算出（既存 raw 経路と同式）。
 *   3. embedNotoSansCJKjp（pdf-lib・捨て PDFDocument）でメトリクス用 font を準備し
 *      `computeUniformFontSize` を呼ぶ（uniform 整合・raw 経路と完全同型）。
 *   4. @napi-rs/canvas に NotoSansJP-Overlay を登録 → 各 overlay field を drawText で焼く。
 *      固定テキスト分岐 / uniform 分岐 / baseline 計算は raw 経路と 1:1 同型コピー
 *      （§8-3 同式・mistake.md「等価移植元」原則に従い構造差を作らない）。
 *
 * 個人情報死守: builtin に whiteout_boxes は無いが、合成失敗時は throw（route 側 catch で 500）。
 * bg.png をそのまま返さない契約は raw 経路と同じ（撤退時は呼出側の従来 bg.png 直返しに戻る）。
 */
export async function renderMinuteBuiltinBgWithOverlayToImages(
  input: RenderMinuteBuiltinBgWithOverlayInput,
): Promise<RenderPdfToImagesResult> {
  // 1. bg.png を decode し、実 px 寸法を確定（再ラスタライズなし・builtin は 144 dpi 相当固定）。
  await ensureNotoSansRegisteredForOverlay()
  const { loadImage, createCanvas } = await import('@napi-rs/canvas')
  const bgImg = await loadImage(input.bgPngBytes)
  const pixelW = bgImg.width
  const pixelH = bgImg.height
  if (!Number.isFinite(pixelW) || !Number.isFinite(pixelH) || pixelW <= 0 || pixelH <= 0) {
    throw new Error('BUILTIN_BG_PNG_INVALID_DIMENSIONS')
  }
  if (
    !Number.isFinite(input.pagePtSize.width) ||
    !Number.isFinite(input.pagePtSize.height) ||
    input.pagePtSize.width <= 0 ||
    input.pagePtSize.height <= 0
  ) {
    throw new Error('BUILTIN_PAGE_PT_SIZE_INVALID')
  }
  const sx = pixelW / input.pagePtSize.width
  const sy = pixelH / input.pagePtSize.height

  // 2. fitTextInBox 用の font（raw 経路と完全同型: pdf-lib の捨て PDFDocument）。
  const { PDFDocument } = await import('pdf-lib')
  const metricsDoc = await PDFDocument.create()
  const { embedNotoSansCJKjp } = await import('./font-loader')
  const font = (await embedNotoSansCJKjp(metricsDoc, { subset: true })) as FittableFont

  // 3. uniform 算出（raw 経路 L408-453 と式同型コピー・mistake.md 等価移植元）。
  const uniformTargetNames = input.uniformTargetNames
  let uniformSize: number | null = null
  if (uniformTargetNames && uniformTargetNames.size > 0) {
    const uniformFields = input.overlayFields
      .filter((of) => uniformTargetNames.has(of.field.name))
      .map((of) => of.field)
    if (uniformFields.length > 0) {
      if (typeof input.uniformOverridePt === 'number') {
        uniformSize = input.uniformOverridePt
      } else {
        const uniformPadding: Record<string, FitTextPadding> = {}
        for (const of of input.overlayFields) {
          if (uniformTargetNames.has(of.field.name) && of.userStylePadding) {
            uniformPadding[of.field.name] = of.userStylePadding
          }
        }
        const paddingArg =
          Object.keys(uniformPadding).length > 0 ? uniformPadding : undefined
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

  // 4. canvas 構築 + 背景描画 → 各 field を drawText（raw 経路 L484-571 と式同型コピー）。
  //    builtin は 1 ページ前提（pageRange は受けない）。bg.png にも whiteout_boxes は無い
  //    （seed.sql は whiteout を持たない）。
  const canvas = createCanvas(pixelW, pixelH)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(bgImg, 0, 0, pixelW, pixelH)
  ctx.fillStyle = '#000000'

  const pageFields = input.overlayFields.filter((of) => of.field.bbox.page === 1)
  for (const of of pageFields) {
    const { value, userStylePadding } = of
    if (value === undefined || value === null) continue
    const text = String(value)
    if (text.length === 0) continue

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

    ctx.textBaseline = 'alphabetic'
    const isUniformTarget =
      uniformSize !== null && (uniformTargetNames?.has(of.field.name) ?? false)
    const field = isUniformTarget
      ? { ...of.field, font: { ...of.field.font, size: uniformSize as number } }
      : of.field
    const heightRatio = isUniformTarget ? FIT_HEIGHT_RATIO : undefined
    const lockSize = isUniformTarget

    const fit = fitTextInBox(text, field, font, userStylePadding, heightRatio, {
      lockSize,
    })
    const padding = userStylePadding ?? field.padding
    const fontHeightPt =
      heightRatio === undefined
        ? font.heightAtSize(fit.fontSize)
        : fit.fontSize * heightRatio
    const topPad = isUniformTarget ? UNIFORM_PAD_TOP : padding.top
    const baselineFromTopPt = field.bbox.y + topPad + fontHeightPt
    const lineHeightPt = fontHeightPt * 1.2
    const startX_px = (field.bbox.x + padding.left) * sx
    const fontSizePx = fit.fontSize * sy
    ctx.font = `${fontSizePx}px "${OVERLAY_FONT_FAMILY_NAME}"`

    fit.lines.forEach((line, i) => {
      const baselineY_px = (baselineFromTopPt + i * lineHeightPt) * sy
      ctx.fillText(line, startX_px, baselineY_px)
    })
  }

  const dpiDecision: DowngradeDecision = {
    dpi: input.requestedDpi,
    downgraded: false,
    estimatedMs: 0,
  }
  return {
    bytes: canvas.toBuffer('image/png'),
    contentType: 'image/png',
    ext: 'png',
    dpiDecision,
    renderedPages: 1,
    warnings: [],
  }
}
