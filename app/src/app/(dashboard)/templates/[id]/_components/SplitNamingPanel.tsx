'use client'

import { useEffect, useRef } from 'react'

/** label の最大文字数（サーバ LABEL_MAX と一致）。入力時点で制限。 */
const LABEL_MAX = 40

/**
 * 分割 2 枠同時命名パネル（グループB Phase B-4）。
 *
 * 「部署＋氏名」を縦2分割した直後に出し、左右それぞれに項目名を入力させる。
 *   - 元 label をプレースホルダ参考表示（区切り文字での機械自動分割はしない＝誤分割防止）。
 *   - 両未入力で確定すると親が「項目N」「項目N+1」を仮置きする。
 * 画面下部中央に固定（スマホ下部 nudge バーや ZoomPanel と被らないよう bottom を上げる）。
 */
export function SplitNamingPanel({
  leftValue,
  rightValue,
  origLabel,
  onLeftChange,
  onRightChange,
  onCommit,
}: {
  leftValue: string
  rightValue: string
  origLabel: string
  onLeftChange: (value: string) => void
  onRightChange: (value: string) => void
  onCommit: () => void
}) {
  const leftRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    // 開いたら左枠の入力欄へフォーカス（左→右の順に命名）。
    leftRef.current?.focus()
  }, [])
  // 元 label を左右のプレースホルダ参考に出す（あくまで参考・自動分割しない）。
  const placeholder = origLabel.trim() || '項目名'
  return (
    <div
      role="dialog"
      aria-label="分割した2枠の項目名を入力"
      className="fixed inset-x-0 bottom-24 sm:bottom-8 z-50 flex justify-center px-3 pointer-events-none"
    >
      <div className="pointer-events-auto w-full max-w-md bg-white border border-gray-200 rounded-lg shadow-lg p-4">
        <p className="text-sm text-gray-700 mb-3">
          分割した2つの枠に項目名を付けてください
        </p>
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex-1">
            <label className="block text-xs text-gray-600 mb-1">左の枠</label>
            <input
              ref={leftRef}
              type="text"
              value={leftValue}
              maxLength={LABEL_MAX}
              placeholder={placeholder}
              onChange={(e) => onLeftChange(e.target.value)}
              className="w-full h-11 px-3 rounded border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-gizirotto-blue-300"
            />
          </div>
          <div className="flex-1">
            <label className="block text-xs text-gray-600 mb-1">右の枠</label>
            <input
              type="text"
              value={rightValue}
              maxLength={LABEL_MAX}
              placeholder={placeholder}
              onChange={(e) => onRightChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  onCommit()
                }
              }}
              className="w-full h-11 px-3 rounded border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-gizirotto-blue-300"
            />
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onCommit}
            className="h-11 px-5 rounded bg-gizirotto-blue-500 hover:bg-gizirotto-blue-700 text-white text-sm font-medium"
          >
            決定
          </button>
        </div>
      </div>
    </div>
  )
}
