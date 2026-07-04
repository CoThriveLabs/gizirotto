import type { PdfBox } from './pdf-types'

export interface RgbColor {
  r: number
  g: number
  b: number
}

export const DEFAULT_BG_COLOR_WHITE: RgbColor = { r: 255, g: 255, b: 255 }

/**
 * source の意味:
 *   - 'auto_suggestion': 自動検出された白塗り候補（補助、品質保証外）
 *   - 'manual': ユーザー UI で確定された矩形（採用判定 or ドラッグ追加）
 */
export type WhiteoutSource = 'auto_suggestion' | 'manual'

export interface WhiteoutBox {
  /** ページ番号（1 始まり、アプリ内部表現）*/
  page: number
  /** 白塗り対象の矩形（左上原点・pt 単位、PdfBox 共通） */
  bbox: PdfBox
  /** 推定背景色（v1 既定: 白）*/
  estimatedBgColor: RgbColor
  /** source。'auto_suggestion' = サジェスト / 'manual' = ユーザー確定 */
  source: WhiteoutSource
}
