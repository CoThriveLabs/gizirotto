'use client'

import {
  type PageMeta,
  type FitOptions,
  type ResizeCorner,
  ptToDispX,
  ptToDispY,
} from '@/lib/pdf-output/bbox-coords'
import {
  type BboxVariant,
  type WhiteoutKind,
  bboxBoxClass,
  bboxHandleClass,
  bboxLabelClass,
} from '../bbox-variant'
import { FIXED_TEXT_FONT_SIZE_RATIO } from '@/lib/pdf-output/fixedtext-adapter'
import type { EditorField } from '../bbox-pane-types'

const HANDLE_SIZE = 10 // 視覚サイズ（px）
// HIT_PAD（透明拡張の片側 px）。10 + 17*2 ≒ 44px 相当の WCAG タップ目標を最大値とする。
// 小 bbox（短辺 <60px・固定テキスト等）では bbox 中央まで侵食して移動判定を奪うため
// bbox 表示短辺に応じて動的に縮小する（小 bbox での移動判定 bugfix）。
const HIT_PAD_MAX = 17
const HIT_PAD_MIN = 2

const CORNERS: { corner: ResizeCorner; cx: 0 | 1; cy: 0 | 1; cursor: string }[] = [
  { corner: 'nw', cx: 0, cy: 0, cursor: 'nwse-resize' },
  { corner: 'ne', cx: 1, cy: 0, cursor: 'nesw-resize' },
  { corner: 'sw', cx: 0, cy: 1, cursor: 'nesw-resize' },
  { corner: 'se', cx: 1, cy: 1, cursor: 'nwse-resize' },
]

export interface BboxFieldItemProps {
  f: EditorField
  meta: PageMeta
  fitOpts: FitOptions
  selected: boolean
  variant: BboxVariant
  whiteoutKindOf?: (name: string) => WhiteoutKind | undefined
  fixedTextValueOf?: (name: string) => string | undefined
  useCanvasBg: boolean
  onStartMove: (e: React.PointerEvent, f: EditorField) => void
  onStartResize: (e: React.PointerEvent, f: EditorField, corner: ResizeCorner) => void
}

export default function BboxFieldItem({
  f,
  meta,
  fitOpts,
  selected,
  variant,
  whiteoutKindOf,
  fixedTextValueOf,
  useCanvasBg,
  onStartMove,
  onStartResize,
}: BboxFieldItemProps) {
  const left = ptToDispX(meta, f.bbox.x, fitOpts)
  const top = ptToDispY(meta, f.bbox.y, fitOpts)
  const w = ptToDispX(meta, f.bbox.x + f.bbox.w, fitOpts) - left
  const h = ptToDispY(meta, f.bbox.y + f.bbox.h, fitOpts) - top
  return (
    <div
      data-box
      onPointerDown={(e) => onStartMove(e, f)}
      className={
        'absolute border-2 cursor-move ' +
        bboxBoxClass(variant, selected, whiteoutKindOf?.(f.name))
      }
      style={{
        left,
        top,
        width: Math.max(2, w),
        height: Math.max(2, h),
      }}
    >
      {/* C-2 v1.3 §3-2-5（A5）: 固定テキストモードのみ、bbox 内に value を fit-to-box 描画。
          サイズは表示高さ基準（dispH * RATIO）で px 換算済み（pt→px は w/h が既に表示px）。
          横溢れは overflow:hidden でクリップ（最終出力は overlay の fitText が真実・近似表示）。
          空 value は枠のみ（描画なし）。
          #17（v1.8 §3-3-2）: canvas 経路時（useCanvasBg）は dynamicFixedTexts が canvas に
          描画するため span プレビューは出さない（二重描画回避）。raw 非対応テンプレでのみ
          span プレビューが従来どおり残る（後方互換）。 */}
      {(() => {
        if (!fixedTextValueOf) return null
        if (useCanvasBg) return null
        const text = fixedTextValueOf(f.name) ?? ''
        if (text.trim() === '') return null
        // v1.7（改行対応）: 1 行あたり fontPx = (h / N) * RATIO・各行を縦に並べる。
        const lines = text.split('\n')
        const n = Math.max(1, lines.length)
        const fontPx = Math.max(6, (h / n) * FIXED_TEXT_FONT_SIZE_RATIO)
        return (
          <span
            className="absolute inset-0 flex flex-col items-center justify-center overflow-hidden pointer-events-none text-gray-900 leading-none"
            style={{ fontSize: fontPx, fontFamily: 'NotoSansJP, sans-serif' }}
          >
            {lines.map((line, i) => (
              <span
                key={i}
                className="block whitespace-nowrap"
                style={{ lineHeight: `${fontPx / FIXED_TEXT_FONT_SIZE_RATIO}px` }}
              >
                {line || ' '}
              </span>
            ))}
          </span>
        )
      })()}

      {/* 日本語 label のみ。枠内左上＋選択中のみ表示（密集かぶり回避・§A4）。
          固定テキストモード（fixedTextValueOf あり）は value を中央プレビューで出すため、
          左上 label バッジは出さない（value と二重表示になるのを防ぐ）。 */}
      {selected && !fixedTextValueOf && (
        <span
          className={
            'absolute top-0 left-0 text-[10px] leading-none px-1 py-0.5 rounded-br whitespace-nowrap pointer-events-none ' +
            bboxLabelClass(variant)
          }
        >
          {f.label}
        </span>
      )}

      {selected &&
        CORNERS.map(({ corner, cx, cy, cursor }) => {
          // bbox 表示短辺に連動して HIT_PAD を縮小（2026-06-14 bugfix）。
          //   - 短辺 >=60px: HIT_PAD_MAX(17) ＝ 44px 相当（WCAG タップ目標維持）
          //   - 短辺 <60px: 短辺/8 を採用（最小 HIT_PAD_MIN=2 でクランプ）
          //     例) 短辺50px → pad=6 → ハンドル合計22px。bbox 中央タップ判定を確保。
          const shortSidePx = Math.min(w, h)
          const hitPad =
            shortSidePx < 60
              ? Math.max(HIT_PAD_MIN, Math.floor(shortSidePx / 8))
              : HIT_PAD_MAX
          return (
            <div
              key={corner}
              onPointerDown={(e) => onStartResize(e, f, corner)}
              // 透明拡張ヒットエリア（最大 44px 相当・小 bbox では動的縮小）。
              // 視覚は内側の小ハンドル（HANDLE_SIZE 固定）。
              style={{
                position: 'absolute',
                left: cx === 0 ? -hitPad : undefined,
                right: cx === 1 ? -hitPad : undefined,
                top: cy === 0 ? -hitPad : undefined,
                bottom: cy === 1 ? -hitPad : undefined,
                width: HANDLE_SIZE + hitPad * 2,
                height: HANDLE_SIZE + hitPad * 2,
                cursor,
                touchAction: 'none',
              }}
              className="flex items-center justify-center"
              aria-label={`${f.label} のサイズ変更ハンドル`}
            >
              <span
                style={{ width: HANDLE_SIZE, height: HANDLE_SIZE }}
                className={bboxHandleClass(variant)}
              />
            </div>
          )
        })}
    </div>
  )
}
