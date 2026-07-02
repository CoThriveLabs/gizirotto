/**
 * 白塗りモーダル用のクライアント安全な型群。lib/parsers/pdf/whiteout-pipeline.ts や
 * lib/pdf-output/bbox-coords.ts に同名/同形の型があるが、そちらはサーバ専用依存
 * （pdf-lib 等）を持つため import しない。意図的なローカル重複。
 */

export interface RgbColor {
  r: number
  g: number
  b: number
}

export interface PdfBoxPt {
  x: number
  y: number
  w: number
  h: number
}

export interface WhiteoutBox {
  page: number
  bbox: PdfBoxPt
  estimatedBgColor: RgbColor
  source: 'auto_suggestion' | 'manual'
}

export interface PageMeta {
  page: number
  widthPt: number
  heightPt: number
  pixelWidth: number
  pixelHeight: number
}

export interface BoxState extends WhiteoutBox {
  /** UI 内部 ID（描画 / 削除用） */
  id: string
  /** サジェストを「ユーザー却下した」フラグ。true なら塗らない */
  dismissed?: boolean
}
