'use client'

import NudgeControls, { type NudgeAction } from '../nudge-controls'

/** 固定テキスト value の最大文字数（サーバ FIXEDTEXT_VALUE_MAX と一致）。 */
const FIXEDTEXT_VALUE_MAX = 100

/**
 * 固定テキストの操作 body（C-2）。WhiteoutControlsBody を下敷きに、
 * 値入力欄（value）を NudgeControls の上に置く。NudgeControls（移動/サイズ/中央寄せ）と
 * 「この固定テキストを削除」は whiteout と同型。値の入力が固定テキスト固有の本質差異。
 */
export function FixedTextControlsBody({
  onNudge,
  onCenter,
  onDelete,
  onSizeStep,
  value,
  onValueChange,
  compact = false,
  dense = false,
  scale = 1,
}: {
  onNudge: (action: NudgeAction) => void
  onCenter: () => void
  onDelete: () => void
  /** 大きさボタン。font.size を delta(pt) ±（中心保持で bbox 連動拡縮）。 */
  onSizeStep: (delta: number) => void
  value: string
  onValueChange: (v: string) => void
  compact?: boolean
  dense?: boolean
  scale?: number
}) {
  const small = compact || dense
  const scaled = dense && scale < 1
  const btnPx = Math.round(40 * scale)
  const delStyle = scaled
    ? { height: btnPx, fontSize: Math.max(10, Math.round(btnPx * 0.34)) }
    : undefined
  return (
    <div className="space-y-2">
      {/* 値入力欄（固定テキスト固有）。max FIXEDTEXT_VALUE_MAX。 */}
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">
          固定テキストの内容
        </label>
        {/* v1.7: 改行対応で textarea 化（Enter で改行）。行数で自動高さ調整。 */}
        <textarea
          value={value}
          maxLength={FIXEDTEXT_VALUE_MAX}
          onChange={(e) => onValueChange(e.target.value)}
          placeholder="例: 定例ミーティング（Enter で改行）"
          rows={Math.min(6, Math.max(1, value.split('\n').length))}
          className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gizirotto-blue-300 resize-y"
        />
      </div>
      {/* 大きさボタン復活: font.size を直接 ±。
          記号のみ「−」「＋」の**正方形ボタン**で、位置ボタン（↑↓←→）と同サイズに揃える。
          寸法は NudgeControls の RepeatButton と同一規則（通常 w-11 h-11／small w-10 h-10／scaled は btnPx）。 */}
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">
          文字の大きさ
        </label>
        <div className="flex items-center" style={{ gap: scaled ? Math.max(2, Math.round(4 * scale)) : 4 }}>
          {([
            { label: '−', aria: '文字を小さく', delta: -2 },
            { label: '＋', aria: '文字を大きく', delta: 2 },
          ] as const).map(({ label, aria, delta }) => (
            <button
              key={aria}
              type="button"
              aria-label={aria}
              onClick={() => onSizeStep(delta)}
              style={
                scaled
                  ? { width: btnPx, height: btnPx, fontSize: Math.max(11, btnPx * 0.36) }
                  : undefined
              }
              className={
                'flex items-center justify-center rounded border border-gizirotto-blue-200 bg-white text-gizirotto-blue-900 text-sm font-medium select-none hover:bg-gizirotto-blue-50 active:bg-gizirotto-blue-100 ' +
                (scaled ? '' : small ? 'w-10 h-10' : 'w-11 h-11')
              }
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <NudgeControls
        disabled={false}
        onNudge={onNudge}
        onCenter={onCenter}
        compact={compact}
        dense={dense}
        scale={scale}
        hideSize
        extra={
          <div>
            <button
              type="button"
              onClick={() => onDelete()}
              style={delStyle}
              className={
                'w-full px-4 rounded border border-red-200 bg-white text-red-700 text-sm font-medium select-none hover:bg-red-50 active:bg-red-100 ' +
                (scaled ? '' : small ? 'h-10' : 'h-11')
              }
            >
              この固定テキストを削除
            </button>
          </div>
        }
      />
    </div>
  )
}
