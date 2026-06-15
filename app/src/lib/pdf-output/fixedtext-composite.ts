/**
 * 固定テキストのサムネ PNG 焼き込みヘルパ。
 *
 * テンプレ一覧で「サムネ画像の中身に固定テキストが見える」要件のため、サムネ生成経路で
 * `FixedText[]` を PNG 上に上書き描画する。本処理は **サムネ専用** で、overlay PDF 出力経路
 * （`regenerate-minute-pdf.ts` → `generateOverlayPdf`）は無改修（fields に疑似 PdfField として
 * 合流する従来経路で完成形 PDF を出す）。サムネは画像化済の PNG なので pdf-lib drawText 経路は
 * 使えず、別系統として @napi-rs/canvas の Canvas2D drawText を使う。
 *
 * 設計原則:
 * - 座標は左上原点 pt（FixedText.bbox） → px へ無変換ポリシーで sx/sy 乗算のみ（whiteout-coords と同型）。
 * - font.size（pt）も同 sy で px 換算。drawText の baseline は top に揃え bbox 内に描画。
 * - フォントは NotoSansJP 固定（既存 font-loader の OTF バイトを @napi-rs/canvas に GlobalFonts.register）。
 *   既登録時の重複登録は内部で一度きりにガード。
 * - 失敗時は throw（呼出側 generateTemplateThumbnail の catch で握り潰し → failed 記録）。
 *   素の PNG（固定テキスト無し）を出して困るのは「固定テキストが見えない」だけで個人情報リスクは
 *   無いため、whiteout のような「漏洩より表示不能を選ぶ」厳格運用は不要。ただし呼び出し側は
 *   既存ガードで失敗時 failed 記録に倒れる挙動を維持する。
 */
import type { RasterizedPage } from '@/lib/parsers/pdf/pdf-page-rasterizer'
import type { FixedText } from './fixedtext-adapter'
import { layoutFixedTextLines } from './fixedtext-draw'

/** @napi-rs/canvas GlobalFonts への NotoSansJP 登録は 1 回きり（プロセス内キャッシュ）。 */
let _fontRegistered = false
const FONT_FAMILY_NAME = 'NotoSansJP'

async function ensureNotoSansRegistered(): Promise<void> {
  if (_fontRegistered) return
  const { GlobalFonts } = await import('@napi-rs/canvas')
  // 既に同名で登録されていれば何もしない（テスト・hot reload で二重登録になる事故防止）。
  if (GlobalFonts.has(FONT_FAMILY_NAME)) {
    _fontRegistered = true
    return
  }
  const { loadNotoSansCJKjpBytes } = await import('./font-loader')
  const { bytes } = loadNotoSansCJKjpBytes()
  // @napi-rs/canvas の registerFromBuffer は Buffer を受ける。Uint8Array → Buffer に詰め直す。
  GlobalFonts.register(Buffer.from(bytes), FONT_FAMILY_NAME)
  _fontRegistered = true
}

/**
 * raw 由来の RasterizedPage（PNG）に、当該ページの固定テキストを上書き描画して
 * PNG バイトを返す。
 *
 * texts は全ページぶんを渡してよい（page 番号で当該ページぶんだけ抽出する）。
 * 当該ページに 1 つも該当が無ければ元 PNG をそのまま返す（無変化＝コスト最小）。
 *
 * @param page  raw PDF をラスタライズした 1 ページ（pixelWidth/Height・pagePtSize 付き）
 * @param texts 固定テキスト要素（全ページ可・左上原点 pt）
 */
export async function compositeFixedTextsOnPng(
  page: RasterizedPage,
  texts: FixedText[],
): Promise<Uint8Array> {
  const pageTexts = texts.filter((t) => t.bbox.page === page.page)
  if (pageTexts.length === 0) {
    return page.pngBuffer
  }

  await ensureNotoSansRegistered()

  const { loadImage, createCanvas } = await import('@napi-rs/canvas')
  const pixelW = page.pixelWidth
  const pixelH = page.pixelHeight
  const sx = pixelW / page.pagePtSize.width
  const sy = pixelH / page.pagePtSize.height

  const img = await loadImage(page.pngBuffer)
  const canvas = createCanvas(pixelW, pixelH)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0, pixelW, pixelH)

  ctx.fillStyle = '#000000'
  ctx.textBaseline = 'top'

  for (const ft of pageTexts) {
    const value = ft.value ?? ''
    if (value.trim() === '') continue
    // 共有純関数（fixedtext-draw）で行ごとの描画指示を得る。①②③④ で同一式（WYSIWYG）。
    //   px 空間で計算するため、bbox・fontSize を sx/sy で px 換算してから渡す（measure も px）。
    //   measure は canvas measureText を注入（エンジン依存・縮小率算出のみ）。
    const fontPx = Math.max(1, ft.font.size * sy)
    const measure = (line: string, size: number): number => {
      ctx.font = `${size}px "${FONT_FAMILY_NAME}"`
      return ctx.measureText(line).width
    }
    // bbox 縦横中央配置（2026-06-14）: 縦中央計算に h（px 換算）も渡す。
    const drawLines = layoutFixedTextLines(
      value,
      {
        x: ft.bbox.x * sx,
        y: ft.bbox.y * sy,
        w: ft.bbox.w * sx,
        h: ft.bbox.h * sy,
      },
      fontPx,
      measure,
    )
    for (const dl of drawLines) {
      ctx.font = `${dl.drawSize}px "${FONT_FAMILY_NAME}"`
      ctx.fillText(dl.text, dl.xPt, dl.topYPt)
    }
  }

  return canvas.toBuffer('image/png')
}
