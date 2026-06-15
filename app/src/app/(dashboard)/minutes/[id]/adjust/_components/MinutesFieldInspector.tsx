'use client'

import { RANGE_MAX } from '@/lib/pdf-output/uniform-size'
import NudgeControls, {
  type NudgeAction,
} from '@/app/(dashboard)/templates/[id]/nudge-controls'

export type TemplateFieldDef = {
  name: string
  label: string
  bbox: { x: number; y: number; w: number; h: number }
  multiline?: boolean
}

export type Tone = 'omakase' | 'calm' | 'polite' | 'bright' | 'custom'

export const TONES: Array<{ value: Tone; label: string }> = [
  { value: 'omakase', label: 'おまかせ' },
  { value: 'calm', label: '落ち着いた' },
  { value: 'polite', label: '丁寧・上品' },
  { value: 'bright', label: '明るく前向き' },
  { value: 'custom', label: '自由' },
]

export const FONT_SIZE_STEP = 1
// 既存 PdfField.font_size_min と一致（読めるギリギリ）
export const FONT_SIZE_MIN = 8
export const FONT_SIZE_MAX = RANGE_MAX

/** label 最大文字数 */
export const LABEL_MAX = 40

/**
 * Inspector body（記入欄用・PC compact / スマホ dense 共通）。
 * templates `FieldControlsBody` 同パターンで、props 切替で 2 通り描画。
 * 中身は v1.0 と同じ:
 *   - ラベル / 値 textarea / 整え方 + 整形 / 大きさ ± + 自動サイズ / 削除 / 位置 ±（nudge ボタン）
 */
export function MinutesFieldInspector({
  field,
  value,
  onValueChange,
  tone,
  onToneChange,
  customText,
  onCustomTextChange,
  onFormat,
  formatting,
  fontSize,
  onFontSizeStep,
  onFontSizeReset,
  onDelete,
  canDelete,
  onNudge,
  onCenter,
  textareaRef,
  labelEditing = false,
  onLabelChange,
  onLabelCommit,
  compact = false,
  dense = false,
  scale = 1,
}: {
  field: TemplateFieldDef
  value: string
  onValueChange: (v: string) => void
  tone: Tone
  onToneChange: (t: Tone) => void
  customText: string
  onCustomTextChange: (v: string) => void
  onFormat: () => void
  formatting: boolean
  fontSize: number | undefined
  onFontSizeStep: (delta: number) => void
  onFontSizeReset: () => void
  onDelete: () => void
  canDelete: boolean
  /** NudgeControls の全 8 アクション（move-* / w-* / h-*）。 */
  onNudge: (action: NudgeAction) => void
  /** 中央寄せ。 */
  onCenter: () => void
  textareaRef: React.RefObject<HTMLTextAreaElement | HTMLInputElement | null>
  /** ラベルインライン編集モード（templates `labelEditing` 同型）。 */
  labelEditing?: boolean
  onLabelChange?: (v: string) => void
  onLabelCommit?: () => void
  compact?: boolean
  dense?: boolean
  scale?: number
}) {
  const small = compact || dense
  const labelFontSize = dense && scale < 1 ? Math.max(10, Math.round(12 * scale)) : 12
  const labelStyle = dense ? { fontSize: labelFontSize } : undefined

  return (
    <div className={dense ? 'space-y-2' : 'space-y-3'}>
      <div className="flex items-center gap-2 flex-wrap" style={labelStyle}>
        <span className="text-xs text-gray-500">選択中:</span>
        {labelEditing && onLabelChange && onLabelCommit ? (
          // ラベルインライン編集: 追加直後の field 名インライン編集。Enter/blur で確定（templates 同方式）。
          <input
            type="text"
            autoFocus
            value={field.label}
            onChange={(e) => onLabelChange(e.target.value)}
            onBlur={onLabelCommit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                onLabelCommit()
              }
            }}
            maxLength={LABEL_MAX}
            placeholder="項目名（例: 議題）"
            aria-label="項目名"
            className="font-medium text-gizirotto-blue-900 border border-gizirotto-blue-200 rounded px-2 py-0.5 text-sm"
          />
        ) : (
          <span className="font-medium text-gizirotto-blue-900">{field.label}</span>
        )}
      </div>

      {field.multiline ? (
        <textarea
          ref={textareaRef as React.RefObject<HTMLTextAreaElement>}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          className={
            'w-full border border-gizirotto-blue-200 rounded px-3 py-2 ' +
            (dense ? 'text-sm min-h-[3rem]' : 'text-base min-h-[6rem]')
          }
          disabled={formatting}
        />
      ) : (
        <input
          ref={textareaRef as React.RefObject<HTMLInputElement>}
          type="text"
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          className={
            'w-full border border-gizirotto-blue-200 rounded px-3 py-2 ' +
            (dense ? 'text-sm' : 'text-base')
          }
          disabled={formatting}
        />
      )}

      {/* 整え方ラジオ + 整形ボタン */}
      <div className="flex items-center gap-1.5 flex-wrap" style={labelStyle}>
        <span className="text-xs text-gray-500">整え方:</span>
        {TONES.map((t) => (
          <label
            key={t.value}
            className={
              'text-xs px-1.5 py-0.5 rounded border cursor-pointer ' +
              (tone === t.value
                ? 'border-gizirotto-blue-500 bg-gizirotto-blue-50 text-gizirotto-blue-800'
                : 'border-gizirotto-blue-100 text-gray-600')
            }
          >
            <input
              type="radio"
              name={`tone-${field.name}`}
              value={t.value}
              checked={tone === t.value}
              onChange={() => onToneChange(t.value)}
              className="sr-only"
            />
            {t.label}
          </label>
        ))}
        <button
          type="button"
          onClick={onFormat}
          disabled={formatting || !value.trim()}
          className="text-xs text-gizirotto-blue-700 hover:text-gizirotto-blue-900 disabled:text-gray-400 ml-auto"
        >
          {formatting ? '整形中…' : '整形する'}
        </button>
      </div>
      {tone === 'custom' && (
        <div>
          <input
            type="text"
            value={customText}
            onChange={(e) => onCustomTextChange(e.target.value)}
            maxLength={200}
            placeholder="どんな感じに整える？（例: 明るく前向きに）"
            disabled={formatting}
            className="w-full border border-gizirotto-blue-200 rounded px-3 py-2 text-sm"
          />
          <p className="text-[11px] text-gray-400 mt-0.5">
            ※自由指示は内容によって脚色・誇張が入る場合があります
          </p>
        </div>
      )}

      {/* NudgeControls 1 個呼び + sizeSlot で第2列を fontSize UI に差替え
          + extra で「そろえる」列の中央寄せ下に「この項目を削除」を縦ぶら下げ。
          結果: PC compact = 縦 3 段 (位置 → 大きさ → 中央寄せ+削除) /
          スマホ dense = 横 3 カラム (位置 | 大きさ | 中央寄せ+削除) で templates と完全同型。 */}
      <NudgeControls
        disabled={false}
        onNudge={onNudge}
        onCenter={onCenter}
        compact={compact}
        dense={dense}
        scale={scale}
        sizeSlot={
          <div>
            <p className="text-xs text-gray-500 mb-1" style={labelStyle}>
              大きさ
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div className="flex items-center" style={{ gap: 4 }}>
                <button
                  type="button"
                  onClick={() => onFontSizeStep(-FONT_SIZE_STEP)}
                  disabled={fontSize !== undefined && fontSize <= FONT_SIZE_MIN}
                  className={
                    'flex items-center justify-center rounded border border-gizirotto-blue-200 bg-white text-gizirotto-blue-900 text-sm font-medium select-none disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gizirotto-blue-50 active:bg-gizirotto-blue-100 ' +
                    (small ? 'w-10 h-10' : 'w-11 h-11')
                  }
                  aria-label="文字サイズを小さく"
                >
                  −
                </button>
                <span className="text-sm tabular-nums w-12 text-center">
                  {fontSize !== undefined ? `${fontSize.toFixed(1)}pt` : '自動'}
                </span>
                <button
                  type="button"
                  onClick={() => onFontSizeStep(FONT_SIZE_STEP)}
                  disabled={fontSize !== undefined && fontSize >= FONT_SIZE_MAX}
                  className={
                    'flex items-center justify-center rounded border border-gizirotto-blue-200 bg-white text-gizirotto-blue-900 text-sm font-medium select-none disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gizirotto-blue-50 active:bg-gizirotto-blue-100 ' +
                    (small ? 'w-10 h-10' : 'w-11 h-11')
                  }
                  aria-label="文字サイズを大きく"
                >
                  ＋
                </button>
              </div>
              <button
                type="button"
                onClick={onFontSizeReset}
                disabled={fontSize === undefined}
                className="text-xs text-gray-600 hover:text-gray-800 disabled:opacity-40 text-left"
              >
                自動サイズに戻す
              </button>
            </div>
          </div>
        }
        extra={
          <button
            type="button"
            onClick={onDelete}
            disabled={!canDelete}
            title={canDelete ? undefined : '最後の項目は削除できません'}
            className={
              'w-full px-4 rounded border border-red-200 bg-white text-red-700 text-sm font-medium select-none disabled:opacity-40 disabled:cursor-not-allowed hover:bg-red-50 active:bg-red-100 ' +
              (small ? 'h-10' : 'h-11')
            }
          >
            この項目を削除
          </button>
        }
      />
    </div>
  )
}
