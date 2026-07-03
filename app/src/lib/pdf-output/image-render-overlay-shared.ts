/**
 * PDF → 画像化レンダラー — raw overlay 経路と builtin 経路が共有する型 + font 登録ヘルパ。
 */
import type { PdfField } from '../ai/schemas/pdf-field-schema'
import type { FitTextPadding } from './fitting'

/** 改行展開済の bbox + value のペア（fixed text の `__L${i}` 展開と同じ表現）。 */
export interface MinuteOverlayField {
  field: PdfField
  value: string
  /** Phase 4 個人スタイル padding 上書き（optional・overlay-generator と同形）。 */
  userStylePadding?: FitTextPadding
}

/**
 * @napi-rs/canvas GlobalFonts への NotoSansJP 登録（1 回きり、プロセス内キャッシュ）。
 * fixedtext-composite.ts と同型のガード。family 名は overlay 経路専用に別名で持つことで
 * fixedtext-composite 側の登録状態と独立にする（同一 OTF を 2 family にぶら下げる）。
 */
export const OVERLAY_FONT_FAMILY_NAME = 'NotoSansJP-Overlay'
let _overlayFontRegistered = false
export async function ensureNotoSansRegisteredForOverlay(): Promise<void> {
  if (_overlayFontRegistered) return
  const { GlobalFonts } = await import('@napi-rs/canvas')
  if (GlobalFonts.has(OVERLAY_FONT_FAMILY_NAME)) {
    _overlayFontRegistered = true
    return
  }
  const { loadNotoSansCJKjpBytes } = await import('./font-loader')
  const { bytes } = loadNotoSansCJKjpBytes()
  GlobalFonts.register(Buffer.from(bytes), OVERLAY_FONT_FAMILY_NAME)
  _overlayFontRegistered = true
}
