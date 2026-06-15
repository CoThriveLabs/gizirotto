/**
 * SimplePdfGenerator — bbox 抽出失敗時のフォールバック動線。
 *
 * テンプレ構造 / 座標を一切使わず、シンプルに「項目ラベル: 値」を上から順次配置する。
 *
 * 仕様:
 *   - A4 縦（595 × 842 pt）
 *   - フォント: Noto Sans CJK JP Regular（embedFont 経由）
 *   - フォントサイズ: 12pt
 *   - 上から下に項目ラベル + 値を順次配置
 *   - ページオーバーフロー時は新ページを追加
 *
 * 用途:
 *   `POST /api/minutes/{id}/export/pdf-fallback`（ユーザー明示選択時）
 *   bbox 抽出失敗 → ユーザーが「項目入力のみ（レイアウト保持なし）」を選んだケース
 *
 * 重要（仕様書 §1-6 v1.6.1）:
 *   本関数は **ユーザーが明示的に SimplePdfGenerator を選んだ場合のみ** 呼び出される。
 *   バックエンド側で自動判断は禁止（mistake.md §50 / §65、C-11）。
 */

const A4_WIDTH_PT = 595
const A4_HEIGHT_PT = 842
const DEFAULT_FONT_SIZE = 12
const DEFAULT_MARGIN_TOP = 50
const DEFAULT_MARGIN_LEFT = 60
const DEFAULT_MARGIN_BOTTOM = 50
const DEFAULT_LINE_HEIGHT_RATIO = 1.5

export interface SimplePdfItem {
  /** 項目ラベル（例: "日時"、"議題"） */
  label: string
  /** 値（multiline OK、改行で複数行に分割される） */
  value: string
}

export interface SimplePdfInput {
  /** ドキュメントタイトル（最上段に大きめ配置、null なら配置しない） */
  title?: string
  /** 項目ラベル + 値のリスト */
  items: SimplePdfItem[]
}

export interface SimplePdfOptions {
  /** 本文フォントサイズ（pt、デフォルト 12） */
  fontSize?: number
  /** タイトルフォントサイズ（pt、デフォルト fontSize * 1.5） */
  titleFontSize?: number
  /** 行間倍率（デフォルト 1.5） */
  lineHeightRatio?: number
}

/**
 * 項目リストから簡素な A4 PDF を生成する。
 *
 * @returns 生成 PDF のバイト列
 */
export async function generateSimplePdf(
  input: SimplePdfInput,
  options: SimplePdfOptions = {},
): Promise<Uint8Array> {
  if (!input.items || input.items.length === 0) {
    throw new Error('SIMPLE_PDF_NO_ITEMS')
  }

  const fontSize = options.fontSize ?? DEFAULT_FONT_SIZE
  const titleFontSize = options.titleFontSize ?? fontSize * 1.5
  const lineHeightRatio = options.lineHeightRatio ?? DEFAULT_LINE_HEIGHT_RATIO

  const { PDFDocument, rgb } = await import('pdf-lib')
  const pdf = await PDFDocument.create()
  const { embedNotoSansCJKjp } = await import('./font-loader')
  const font = (await embedNotoSansCJKjp(pdf, { subset: true })) as {
    widthOfTextAtSize(text: string, size: number): number
    heightAtSize(size: number): number
  }

  const lineHeight = fontSize * lineHeightRatio
  const titleLineHeight = titleFontSize * lineHeightRatio
  const maxWidth = A4_WIDTH_PT - DEFAULT_MARGIN_LEFT * 2

  // 文字単位で折り返す（FittingText でも使う wrapText 相当の最小実装）
  const wrapByChar = (text: string, size: number): string[] => {
    const out: string[] = []
    for (const rawLine of text.split('\n')) {
      let current = ''
      for (const ch of rawLine) {
        const candidate = current + ch
        if (font.widthOfTextAtSize(candidate, size) > maxWidth && current.length > 0) {
          out.push(current)
          current = ch
        } else {
          current = candidate
        }
      }
      out.push(current)
    }
    return out
  }

  let currentPage = pdf.addPage([A4_WIDTH_PT, A4_HEIGHT_PT])
  let cursorY = A4_HEIGHT_PT - DEFAULT_MARGIN_TOP

  const drawLine = (text: string, size: number, lineH: number): void => {
    // ページ下端に到達したら新ページ
    if (cursorY - lineH < DEFAULT_MARGIN_BOTTOM) {
      currentPage = pdf.addPage([A4_WIDTH_PT, A4_HEIGHT_PT])
      cursorY = A4_HEIGHT_PT - DEFAULT_MARGIN_TOP
    }
    // pdf-lib: y は左下原点、文字 baseline 基準
    // text の上端を cursorY に揃えるため、cursorY - lineH に置く
    currentPage.drawText(text, {
      x: DEFAULT_MARGIN_LEFT,
      y: cursorY - lineH * 0.8,
      size,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      font: font as any,
      color: rgb(0, 0, 0),
    })
    cursorY -= lineH
  }

  // タイトル
  if (input.title) {
    const wrapped = wrapByChar(input.title, titleFontSize)
    for (const line of wrapped) {
      drawLine(line, titleFontSize, titleLineHeight)
    }
    cursorY -= lineHeight * 0.5 // タイトルと本文の間の余白
  }

  // 項目
  for (const item of input.items) {
    const composed = `${item.label}: ${item.value}`
    const wrapped = wrapByChar(composed, fontSize)
    for (const line of wrapped) {
      drawLine(line, fontSize, lineHeight)
    }
    // 項目間に少し余白
    cursorY -= lineHeight * 0.3
  }

  return await pdf.save()
}
