'use client'

/**
 * ズームパネル（Phase 4 共通化）。
 *
 * bbox-editor-client.tsx L2352-2409 / AdjustView.tsx L2406-2463 /
 * MinutesViewer.tsx L138-195 の 3 実装は className・DOM 構造ともに完全一致。
 * 差分ゼロのため 1 コンポーネントに統一。props 化なし。
 *
 * 配置: fixed right-3 bottom-2 md:bottom-4 z-40（3 ファイル共通）。
 */
import { clampZoom, ZOOM_MIN, ZOOM_MAX, ZOOM_STEP } from './constants'

export function ZoomPanel({
  zoom,
  onZoom,
}: {
  zoom: number
  onZoom: (z: number) => void
}) {
  const pct = Math.round(zoom * 100)
  return (
    <div className="fixed right-3 bottom-2 md:bottom-4 z-40 flex items-center gap-2 bg-white/95 border border-gray-200 rounded-full px-3 py-2 shadow-lg">
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        className="text-gray-600"
      >
        <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
        <path
          d="M21 21 L16 16"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
      <button
        type="button"
        aria-label="縮小"
        onClick={() => onZoom(clampZoom(zoom - ZOOM_STEP))}
        className="w-7 h-7 flex items-center justify-center rounded-full border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
      >
        −
      </button>
      <input
        type="range"
        aria-label="ズーム倍率"
        min={ZOOM_MIN}
        max={ZOOM_MAX}
        step={ZOOM_STEP}
        value={zoom}
        onChange={(e) => onZoom(clampZoom(Number(e.target.value)))}
        className="w-24 md:w-32 accent-gizirotto-blue-500"
      />
      <button
        type="button"
        aria-label="拡大"
        onClick={() => onZoom(clampZoom(zoom + ZOOM_STEP))}
        className="w-7 h-7 flex items-center justify-center rounded-full border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
      >
        ＋
      </button>
      <span className="text-xs text-gray-600 tabular-nums w-10 text-right">
        {pct}%
      </span>
    </div>
  )
}
