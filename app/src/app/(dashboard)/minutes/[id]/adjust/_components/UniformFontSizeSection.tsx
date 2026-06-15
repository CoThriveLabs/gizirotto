'use client'

import { RANGE_MAX, RANGE_MIN } from '@/lib/pdf-output/uniform-size'

/**
 * 全体の文字サイズ セクション。
 *
 * - 配置: 右パネル上部（per-field sizeSlot とは視覚的に明確に分離）。
 * - 表示: 「全体の文字サイズ: {n}pt」。pt 表示。
 * - 編集 UI: 数値入力（type=number）+ ±ボタン併設。
 * - クランプ: RANGE_MIN..RANGE_MAX にハードクランプ。
 * - リセット: 「自動に戻す」で uniformOverridePt = null（自動算出へ戻る）。
 *
 * ⚠️ per-field の sizeSlot（onFontSizeStep / onFontSizeReset）は触らない。
 */
export function UniformFontSizeSection({
  displayPt,
  overridePt,
  onChange,
  onStep,
  onReset,
  notice,
}: {
  /** 現在プレビューに注入されている uniform 値（手動なら手動値・自動なら snap 後）。 */
  displayPt: number | undefined
  /** 手動上書き値（null = 自動算出）。 */
  overridePt: number | null
  onChange: (pt: number | null) => void
  onStep: (delta: number) => void
  onReset: () => void
  notice: string | null
}) {
  // 入力欄は controlled。手動 = 手動値、自動 = displayPt（編集すると手動化）。
  const inputValue =
    overridePt !== null
      ? String(Math.round(overridePt))
      : displayPt !== undefined
        ? String(Math.round(displayPt))
        : ''
  const handleCommit = (s: string) => {
    const n = Number.parseFloat(s)
    if (!Number.isFinite(n)) return
    onChange(n)
  }
  const isManual = overridePt !== null
  return (
    <div
      className="bg-white border border-gray-200 rounded-lg px-3 py-3 shadow-sm"
      aria-labelledby="uniform-font-size-heading"
    >
      <div className="flex items-baseline justify-between mb-2">
        <h2
          id="uniform-font-size-heading"
          className="text-sm font-medium text-gizirotto-blue-900"
        >
          全体の文字サイズ
        </h2>
        <span className="text-xs text-gray-500">
          {isManual ? '手動' : '自動'}
        </span>
      </div>
      <p className="text-xs text-gray-600 mb-2">
        現在: {displayPt !== undefined ? `${Math.round(displayPt)}pt` : '—'}
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onStep(-1)}
          className="flex items-center justify-center rounded border border-gizirotto-blue-200 bg-white text-gizirotto-blue-900 text-sm font-medium w-10 h-10 select-none hover:bg-gizirotto-blue-50 active:bg-gizirotto-blue-100"
          aria-label="全体の文字サイズを小さく"
        >
          −
        </button>
        <input
          type="number"
          min={RANGE_MIN}
          max={RANGE_MAX}
          step={1}
          value={inputValue}
          onChange={(e) => handleCommit(e.target.value)}
          aria-label="全体の文字サイズ（pt）"
          className="w-16 h-10 border border-gizirotto-blue-200 rounded px-2 text-sm tabular-nums text-center"
        />
        <span className="text-sm text-gray-600">pt</span>
        <button
          type="button"
          onClick={() => onStep(1)}
          className="flex items-center justify-center rounded border border-gizirotto-blue-200 bg-white text-gizirotto-blue-900 text-sm font-medium w-10 h-10 select-none hover:bg-gizirotto-blue-50 active:bg-gizirotto-blue-100"
          aria-label="全体の文字サイズを大きく"
        >
          ＋
        </button>
        <button
          type="button"
          onClick={onReset}
          disabled={!isManual}
          className="ml-auto text-xs text-gray-600 hover:text-gray-800 disabled:opacity-40"
        >
          自動に戻す
        </button>
      </div>
      <p
        role="status"
        aria-live="polite"
        className={
          'mt-2 text-xs ' +
          (notice ? 'text-amber-700' : 'text-transparent select-none')
        }
      >
        {notice ?? ' '}
      </p>
    </div>
  )
}
