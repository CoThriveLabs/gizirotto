/**
 * 画質自動調整トースト発火ヘルパー（T-E-3）。
 *
 * render-image API レスポンスから downgraded フラグ or warnings 配列を
 * チェックし、ユーザー向け日本語メッセージで toast を出す。
 *
 * UI 表現規約: "dpi" / "downgrade" 等の専門用語禁止 → 「画質を自動調整しました」
 */
import type { ToastKind } from './toast-context'
import type { ImageRenderWarning } from '@/lib/pdf-output/image-renderer'

export interface RenderImageApiResponse {
  cached?: boolean
  signedUrl?: string | null
  dpi?: number
  originalDpi?: number
  downgraded?: boolean
  warnings?: ImageRenderWarning[]
}

export function maybeNotifyImageAdjusted(
  res: RenderImageApiResponse,
  showToast: (kind: ToastKind, message: string) => void,
): void {
  if (res.downgraded) {
    showToast(
      'info',
      '画像のサイズが大きいため、画質を自動調整して保存しました。',
    )
    return
  }
  const dpiWarn = res.warnings?.find(
    (w) =>
      w.type === 'dpi_auto_downgrade' || w.type === 'over_threshold_min_dpi',
  )
  if (dpiWarn) {
    showToast(
      'info',
      '画像のサイズが大きいため、画質を自動調整して保存しました。',
    )
  }
}
