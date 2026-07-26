'use client'

/**
 * bbox 可視化＋編集ペイン（G2-1 設計書 v0.2 §2-1 / §2-2）。
 *
 * 背景 PNG の上に bbox オーバーレイ（青枠）を重畳し、
 *   - 枠クリックで選択
 *   - 選択枠の本体ドラッグ = 移動
 *   - 四隅ハンドル = リサイズ（最小 4pt クランプ・反転禁止）
 *   - 当たり判定はタッチ向けに 44px 相当（透明拡張ヒットエリア）
 * を提供する。Pointer events 基盤は whiteout PagePane を流用（setPointerCapture/
 * touch-none/select-none）。座標計算は lib/pdf-output/bbox-coords の純関数のみ使用。
 *
 * 編集中は pt 空間で直接計算（px↔pt 往復をしない）。確定丸めは保存時のみ（§3）。
 */
import { useEffect, useRef, useState } from 'react'
import {
  type FitOptions,
  displayWidth,
  displayHeight,
  ptToDispX,
  ptToDispY,
} from '@/lib/pdf-output/bbox-coords'
import { usePointerBboxEdit } from './use-pointer-bbox-edit'
import { useBboxCanvasComposite } from './use-bbox-canvas-composite'
import type { Props } from './bbox-pane-types'
import BboxFieldItem from './_components/BboxFieldItem'
import BboxReferenceLayer from './_components/BboxReferenceLayer'
import BboxGridOverlay from './_components/BboxGridOverlay'

export type { EditorField, SelectionGeom } from './bbox-pane-types'

export default function BboxPane({
  meta,
  imageUrl,
  fields,
  selectedName,
  onSelect,
  onChangeBbox,
  onDragStart,
  onDragCommit,
  onSelectionGeom,
  zoom,
  viewportHeight,
  showGrid,
  variant = 'field',
  whiteoutKindOf,
  whiteoutRawImageUrl,
  whiteoutBgColorOf,
  referenceFields,
  referenceVariant,
  onDisplayWidth,
  fixedTextValueOf,
  keepAspect = false,
  dynamicWhiteoutBoxes,
  dynamicFixedTexts,
  dynamicFieldValues,
  fieldValuesUniformFontSize,
  fieldValuesPreviewFont,
  freezeDragLayer = false,
}: Props) {
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const outerRef = useRef<HTMLDivElement | null>(null)
  const whiteoutCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const useCanvasBg = !!whiteoutRawImageUrl

  // スマホ連動（§A1）: 外側コンテナの実幅を ResizeObserver で購読し、表示幅の上限にする。
  // 初期 undefined（containerWidth 注入前）は従来挙動 min(pixelWidth,800) で後方互換。
  const [containerWidth, setContainerWidth] = useState<number | undefined>(undefined)
  useEffect(() => {
    const el = outerRef.current
    if (!el) return
    const update = () => setContainerWidth(el.clientWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 表示フィット/ズームのオプション（PY1-1）。描画(ptToDisp)と座標変換(dispToPt)で
  // 同一 fitOpts を使うことが往復一致（±4px）の死守条件。
  const fitOpts: FitOptions = { containerWidth, viewportHeight, zoom }

  const dispW = displayWidth(meta, fitOpts)
  const dispH = displayHeight(meta, fitOpts)

  // 段階2 Phase 2-D 修正（実機FB）: PDF 実表示幅(dispW)を親へ通知（フロート幅を PDF 幅に追従）。
  // dispW が変わるたび（containerWidth/縦フィット/zoom 変化）に通知。描画には影響しない（座標非破壊）。
  useEffect(() => {
    onDisplayWidth?.(dispW)
  }, [dispW, onDisplayWidth])

  const { drag, startMove, startResize, handlePointerMove, endDrag } = usePointerBboxEdit({
    meta,
    fields,
    fitOpts,
    wrapperRef,
    onSelect,
    onChangeBbox,
    onDragStart,
    onDragCommit,
    keepAspect,
  })

  useBboxCanvasComposite({
    canvasRef: whiteoutCanvasRef,
    meta,
    variant,
    fields,
    useCanvasBg,
    whiteoutRawImageUrl,
    whiteoutBgColorOf,
    dynamicWhiteoutBoxes,
    dynamicFixedTexts,
    dynamicFieldValues,
    fieldValuesUniformFontSize,
    fieldValuesPreviewFont,
    freezeDragLayer,
    drag,
  })

  // 選択 bbox の画面位置を親へ通知（フローティング nudge 近傍配置・§A3 / §A3改訂-⑧）。
  //
  // ⑧ 操作中固定（方式(a)）: 依存配列から fields（bbox 値）を意図的に除外する。
  // 同一 bbox の移動/リサイズ/1px 中は geom を再計算しない＝ウィジェットが操作中に動かない。
  // 選択切替（selectedName）・表示倍率変化（containerWidth）・ページ寸法（meta）でのみ再配置する。
  // selectedName 変化時は必ず再レンダーされ最新 fields クロージャで実行されるので位置は正しい。
  useEffect(() => {
    if (!onSelectionGeom) return
    const sel = fields.find((f) => f.name === selectedName)
    const el = wrapperRef.current
    if (!sel || !el) {
      onSelectionGeom(null)
      return
    }
    const rect = el.getBoundingClientRect()
    const left = ptToDispX(meta, sel.bbox.x, fitOpts)
    const top = ptToDispY(meta, sel.bbox.y, fitOpts)
    const w = ptToDispX(meta, sel.bbox.x + sel.bbox.w, fitOpts) - left
    const h = ptToDispY(meta, sel.bbox.y + sel.bbox.h, fitOpts) - top
    onSelectionGeom({
      name: sel.name,
      viewportLeft: rect.left + left,
      viewportTop: rect.top + top,
      width: w,
      height: h,
    })
    // ⑧: fields を依存から外し操作中不動にする（選択/倍率/寸法でのみ再配置）。
    // zoom/viewportHeight も倍率変化なので再配置トリガに含める（PY1-1）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedName, containerWidth, viewportHeight, zoom, meta, onSelectionGeom])

  // ④選択青枠中心の表示px（中心線描画用・PY1-4）。未選択なら null。
  const selForGrid = fields.find((f) => f.name === selectedName) ?? null
  const selCenter = selForGrid
    ? {
        x: ptToDispX(meta, selForGrid.bbox.x + selForGrid.bbox.w / 2, fitOpts),
        y: ptToDispY(meta, selForGrid.bbox.y + selForGrid.bbox.h / 2, fitOpts),
      }
    : null

  return (
    <div ref={outerRef}>
      <p className="text-xs text-gray-500 mb-1">ページ {meta.page}</p>
      {/* ③拡大時のはみ出しをスクロール（scroll-container）＋①中央寄せ（centerer）。
          zoom=1（全体フィット）でははみ出さない。 */}
      <div className="overflow-auto">
        <div className="flex justify-center min-w-min">
          {/* 枠線は outline（box 寸法不変・§A2-2）。border だと box-sizing で内側が縮み
              背景 img と bbox 座標系がズレるため outline 化して一致させる。 */}
          <div
            ref={wrapperRef}
            className="relative select-none bg-gray-100 touch-none outline outline-1 outline-gray-300"
            style={{ width: dispW, height: dispH }}
            onPointerDown={() => onSelect(null)}
            onPointerMove={handlePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
        {/* ②動的プレビュー（§2-2）: 白塗りモードは raw を <canvas> に描き編集中 fields を都度合成。
            記入欄/固定テキスト（および raw 非対応テンプレ）は従来 <img>（焼込済）のまま無改修。 */}
        {useCanvasBg ? (
          <canvas
            ref={whiteoutCanvasRef}
            width={meta.pixelWidth}
            height={meta.pixelHeight}
            style={{ width: dispW, height: dispH }}
            className="absolute inset-0 pointer-events-none"
          />
        ) : (
          imageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imageUrl}
              alt={`ページ ${meta.page}`}
              width={dispW}
              height={dispH}
              draggable={false}
              className="absolute inset-0 w-full h-full pointer-events-none"
            />
          )
        )}

        {referenceFields && (
          <BboxReferenceLayer
            referenceFields={referenceFields}
            referenceVariant={referenceVariant}
            variant={variant}
            meta={meta}
            fitOpts={fitOpts}
          />
        )}

        {fields.map((f) => (
          <BboxFieldItem
            key={f.name}
            f={f}
            meta={meta}
            fitOpts={fitOpts}
            selected={f.name === selectedName}
            variant={variant}
            whiteoutKindOf={whiteoutKindOf}
            fixedTextValueOf={fixedTextValueOf}
            useCanvasBg={useCanvasBg}
            onStartMove={startMove}
            onStartResize={startResize}
          />
        ))}

            {showGrid && <BboxGridOverlay dispW={dispW} dispH={dispH} selCenter={selCenter} />}
          </div>
        </div>
      </div>
    </div>
  )
}
