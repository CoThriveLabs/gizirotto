/**
 * dpi 自動降格ロジック。
 *
 * estimatedMs = totalPages × dpiCostMs(dpi) > 8000ms のとき
 * dpi を 1 段下げて再見積（300 → 200 → 150 → 100）。
 *
 * 閾値 8000ms = Hobby 標準 10 秒 − 安全マージン 2 秒（worker overhead 350ms +
 * ZIP まとめ + ネットワーク余裕）。
 */

/** §3-10-d 降格対象 dpi ladder */
export const DPI_LADDER = [300, 200, 150, 100] as const

/** §3-10-d 閾値（ms） */
export const ESTIMATED_MS_THRESHOLD = 8000

/**
 * 1 ページあたりの推定処理時間（ms）。
 * Day 2 T-3 実測ベース（dpi 300 × 10 ページ = 8914ms → 単頁 ≒ 890ms）。
 * dpi 150 ≒ 510ms、dpi 72 ≒ 390ms（V-8 実測）。
 */
export function dpiCostMs(dpi: number): number {
  // 単頁 ≒ scale^2 にほぼ比例（解像度面積比）。
  // V-8/T-3 実測の中央値を fit させた近似式: cost ≒ 0.012 × dpi^2 ms + 200 ms (worker base)
  return Math.round(0.012 * dpi * dpi + 200)
}

export interface DowngradeDecision {
  /** 採用 dpi */
  dpi: number
  /** 推定総処理時間（ms） */
  estimatedMs: number
  /** 元 dpi から降格したか */
  downgraded: boolean
  /** 降格元 dpi（downgraded=true の時のみ） */
  originalDpi?: number
}

/**
 * dpi 自動降格決定。
 *
 * @param requestedDpi  クライアント要求 dpi（72-300 clamp 済前提）
 * @param totalPages    レンダリング対象ページ数
 * @param forceDpi      true なら降格無効化（ユーザーが画質最優先指定、§3-10-d 脱出ハッチ）
 */
export function decideDpi(
  requestedDpi: number,
  totalPages: number,
  forceDpi = false,
): DowngradeDecision {
  if (forceDpi) {
    return {
      dpi: requestedDpi,
      estimatedMs: totalPages * dpiCostMs(requestedDpi),
      downgraded: false,
    }
  }

  // requestedDpi 以下の ladder を作る（昇順 ladder から要求値以下を抽出 + 要求値自体を含む）
  const candidates = [requestedDpi, ...DPI_LADDER.filter(d => d < requestedDpi)]
  for (const dpi of candidates) {
    const estimatedMs = totalPages * dpiCostMs(dpi)
    if (estimatedMs <= ESTIMATED_MS_THRESHOLD) {
      return {
        dpi,
        estimatedMs,
        downgraded: dpi !== requestedDpi,
        ...(dpi !== requestedDpi ? { originalDpi: requestedDpi } : {}),
      }
    }
  }
  // 最低 dpi(100) でも超過: 最低値で諦めて返す（呼出側で warning + ベストエフォート）
  const minDpi = DPI_LADDER[DPI_LADDER.length - 1]
  return {
    dpi: minDpi,
    estimatedMs: totalPages * dpiCostMs(minDpi),
    downgraded: minDpi !== requestedDpi,
    ...(minDpi !== requestedDpi ? { originalDpi: requestedDpi } : {}),
  }
}

/** 72-300 にクランプ + 整数化 */
export function clampDpi(v: number | undefined, fallback = 150): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback
  return Math.max(72, Math.min(300, n))
}
