'use client'

import Link from 'next/link'
import { useEffect, useRef } from 'react'
import type { FittableFont } from '@/lib/pdf-output/fitting'
import type { PageMeta } from '@/lib/pdf-output/bbox-coords'
import { UndoRedoButtons } from '@/components/editor/UndoRedoButtons'
import { ZoomPanel } from '@/components/editor/ZoomPanel'
import BboxPane, {
  type SelectionGeom,
} from '@/app/(dashboard)/templates/[id]/bbox-pane'
import { UniformFontSizeSection } from './UniformFontSizeSection'
import { UnsavedChangesModal } from '@/components/editor/UnsavedChangesModal'
import type { useMinuteAdjustEditor } from '@/hooks/editor/useMinuteAdjustEditor'
import type { useMinuteSaveLifecycle } from '../use-minute-save-lifecycle'
import {
  computeAutoScrollDelta,
  resolveWhiteoutRawImageUrl,
  type TemplateFieldDef,
} from '../adjust-view-helpers'

/** 選択枠の下辺とスマホ用モーダル上辺の間に確保する最低余白（px）。 */
const SELECTION_MODAL_MIN_GAP_PX = 4

/** fields 配列の上限。20 で「項目を追加」disabled（hook の handleAddField ガードと一致）。 */
const FIELDS_MAX = 20

interface AdjustViewLayoutProps {
  editor: ReturnType<typeof useMinuteAdjustEditor>
  save: ReturnType<typeof useMinuteSaveLifecycle>
  header: {
    title: string
    onTitleChange: (v: string) => void
    meetingDate: string
    onMeetingDateChange: (v: string) => void
    guestMode?: boolean
    minuteId: string
    onBackToViewerClick: (e: React.MouseEvent<HTMLAnchorElement>) => void
    dirty: boolean
  }
  view: {
    zoom: number
    onZoom: (z: number) => void
    showGrid: boolean
    onToggleGrid: () => void
    pdfDisplayWidth: number | null
    onDisplayWidth: (w: number) => void
    previewFont: FittableFont | null
    pageSizes: PageMeta[]
    rawBgUrl: string | null
    setSelectionGeom: (g: SelectionGeom | null) => void
    selectionGeom: SelectionGeom | null
  }
  errorMsg: string | null
  selectedField: TemplateFieldDef | null
  renderInspector: (variant: 'compact' | 'dense') => React.ReactNode
}

export default function AdjustViewLayout({
  editor,
  save,
  header,
  view,
  errorMsg,
  selectedField,
  renderInspector,
}: AdjustViewLayoutProps) {
  // スマホ用インスペクタ（下部固定モーダル）に選択中 bbox が隠れないための自動スクロール。
  // モーダル ref は selectedField の真偽だけで DOM にマウントされる（md:hidden は CSS で
  // 非表示にするだけで、要素自体は PC 幅でも存在する）。そのため display:none の要素に
  // getBoundingClientRect() を呼ぶと zero-rect（top:0 等）が返り誤った delta を計算して
  // しまうので、computedStyle で非表示を検知し早期 return する。
  const mobileModalRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!selectedField) return
    const modalEl = mobileModalRef.current
    const geom = view.selectionGeom
    if (!modalEl || !geom) return
    // 選択が A→B に変わった commit では、子（bbox-pane）の effect が先に走って B の geom を
    // setState する一方、この親 effect は selectedField 変化で発火しつつクロージャ内の
    // selectionGeom はまだ A のまま。scrollBy は相対量なので、そのまま走らせると A 分と
    // B 分を二重にスクロールしてしまう。geom の name が現在の選択と一致する時だけ動かす。
    if (geom.name !== selectedField.name) return
    if (window.getComputedStyle(modalEl).display === 'none') return
    const delta = computeAutoScrollDelta({
      selectionBottom: geom.viewportTop + geom.height,
      modalTop: modalEl.getBoundingClientRect().top,
      minGap: SELECTION_MODAL_MIN_GAP_PX,
    })
    if (delta <= 0) return
    window.scrollBy({ top: delta, behavior: 'smooth' })
    // selectionGeom は bbox-pane 側で選択/倍率/ページ寸法変化時のみ再計算される（ドラッグ中は不変）。
    // スクロール自体はその依存に含まれないため、ここで再スクロールを誘発する連鎖は起きない。
  }, [selectedField, view.selectionGeom])

  return (
    <div className="space-y-3">
      {/* 閲覧画面への戻り導線。guestMode は保存済み minute を持たないためテンプレ選択画面へ。 */}
      <div className="flex items-center gap-3">
        <Link
          href={header.guestMode ? '/templates' : `/minutes/${header.minuteId}`}
          onClick={header.onBackToViewerClick}
          className="text-sm text-gizirotto-blue-700 hover:underline"
        >
          {header.guestMode ? '← テンプレ選択に戻る' : '← 閲覧画面に戻る'}
        </Link>
      </div>

      {/* タイトル / 開催日の編集 UI。dirty 連動 → 保存ボタン経路で updateMinute に乗せる。 */}
      <div className="space-y-3">
        <div>
          <label className="text-xs text-gray-700" htmlFor="minute-title">
            タイトル
          </label>
          <input
            id="minute-title"
            type="text"
            value={header.title}
            onChange={(e) => header.onTitleChange(e.target.value)}
            maxLength={100}
            className="w-full mt-1 border border-gizirotto-blue-200 rounded px-3 py-2 text-base"
            required
          />
        </div>
        <div>
          <label className="text-xs text-gray-700" htmlFor="minute-meeting-date">
            開催日
          </label>
          <input
            id="minute-meeting-date"
            type="date"
            value={header.meetingDate}
            onChange={(e) => header.onMeetingDateChange(e.target.value)}
            className="mt-1 border border-gizirotto-blue-200 rounded px-3 py-2 text-base"
            required
          />
        </div>
      </div>

      {/* ヘッダー: 説明文 ↔ ボタン列を横並び右寄せ。
          ボタン列順序: [グリッド表示] → [← 戻る][進む →] → [項目を追加] → [保存]。
          1 行に収まらない幅では、説明文を縮め続けず（min-w で下限を確保）ボタン列ごと次の行へ
          折り返す（flex-wrap の通常挙動に委譲。強制 nowrap は使わない）。 */}
      <div className="flex items-center justify-between gap-3 flex-wrap pb-1">
        <p className="text-sm text-gray-600 sm:flex-1 min-w-[250px]">
          項目をタップして選び、値・位置・大きさを調整してください。
        </p>
        <div className="flex items-center gap-3 sm:shrink-0">
          <button
            type="button"
            onClick={view.onToggleGrid}
            aria-pressed={view.showGrid}
            className={
              'text-sm font-medium px-3 py-2 rounded border ' +
              (view.showGrid
                ? 'bg-gizirotto-blue-500 border-gizirotto-blue-500 text-white'
                : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50')
            }
          >
            グリッド表示
          </button>
          <UndoRedoButtons
            onUndo={editor.undo}
            onRedo={editor.redo}
            canUndo={editor.canUndo && !save.saving}
            canRedo={editor.canRedo && !save.saving}
          />
          <button
            type="button"
            onClick={editor.handleAddField}
            disabled={editor.fields.length >= FIELDS_MAX || save.saving}
            title={
              editor.fields.length >= FIELDS_MAX ? '項目は20個までです' : undefined
            }
            className="bg-white border border-gizirotto-blue-500 text-gizirotto-blue-700 hover:bg-gizirotto-blue-500/10 font-medium px-3 py-2 rounded text-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            項目を追加
          </button>
          <button
            type="button"
            onClick={save.onSave}
            disabled={save.saving || (!header.guestMode && !header.dirty && save.firstSaveConsumed)}
            className="bg-gizirotto-blue-500 hover:bg-gizirotto-blue-700 text-white font-medium px-3 py-2 rounded text-sm disabled:opacity-50"
          >
            {save.saving ? '保存中…' : header.guestMode ? 'ログインして保存' : '保存'}
          </button>
        </div>
      </div>

      {/* PC: 2 カラム grid（左=プレビュー / 右=aside 固定パネル）/ スマホ: プレビューのみ + 下バー */}
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_320px] gap-4 items-start">
        {/* スマホ用モーダル（下部固定・max-h-[50vh] + bottom-14）に隠れず末尾項目まで
            スクロールで到達できるよう、モーダル分の余白を下に確保する（md 以上は aside 固定
            パネルでモーダル自体が存在しないため pb 不要＝0 に戻す）。 */}
        <div className="pb-[calc(50vh+80px)] md:pb-0">
          {view.pageSizes.length > 0 ? (
            view.pageSizes.map((meta) => (
              <BboxPane
                key={meta.page}
                meta={meta}
                imageUrl={null}
                fields={editor.editorFields.filter((f) => f.bbox.page === meta.page)}
                selectedName={editor.selected}
                onSelect={editor.setSelected}
                onChangeBbox={editor.handleChangeBbox}
                onDragStart={editor.handleDragStart}
                onDragCommit={editor.handleDragCommit}
                onSelectionGeom={view.setSelectionGeom}
                zoom={view.zoom}
                variant="field"
                // ドラッグ中レイヤ凍結: adjust だけ ON（templates 側 BboxPane 呼びには渡さない＝false）。
                freezeDragLayer
                whiteoutRawImageUrl={resolveWhiteoutRawImageUrl(
                  editor.isDragging,
                  view.rawBgUrl,
                  editor.selectedOnlyBgUrl,
                )}
                onDisplayWidth={view.onDisplayWidth}
                dynamicFieldValues={editor.dynamicFieldValues}
                fieldValuesUniformFontSize={editor.fieldValuesUniformFontSize}
                fieldValuesPreviewFont={view.previewFont ?? undefined}
                showGrid={view.showGrid}
              />
            ))
          ) : (
            <p className="text-sm text-gray-500 py-8 text-center">
              背景を読み込んでいます…
            </p>
          )}
        </div>

        {/* PC: 右 aside 固定パネル。 */}
        <aside className="hidden md:block md:sticky md:top-4 self-start space-y-3">
          {/* 全体の文字サイズ（minute 単位の手動上書き）。選択 field の有無に依存せず常に表示。 */}
          <UniformFontSizeSection
            displayPt={editor.fieldValuesUniformFontSize}
            overridePt={editor.uniformOverridePt}
            onChange={editor.onUniformOverrideChange}
            onStep={editor.onUniformOverrideStep}
            onReset={editor.onUniformOverrideReset}
            notice={editor.uniformOverrideNotice}
          />
          <div className="bg-white border border-gray-200 rounded-lg px-3 py-3 shadow-sm">
            {selectedField ? (
              renderInspector('compact')
            ) : (
              <p className="text-sm text-gray-500 py-8 text-center">
                枠を選んでください
              </p>
            )}
          </div>
        </aside>
      </div>

      {/* スマホ: FloatingShell 下部中央バー（md 未満専用）。選択中 → Inspector dense。 */}
      {selectedField && (
        <div
          ref={mobileModalRef}
          className="md:hidden fixed inset-x-0 bottom-14 z-30 flex justify-center px-3 pointer-events-none"
        >
          <div
            className="pointer-events-auto bg-white/95 border border-gray-200 rounded-lg px-2.5 py-2 shadow-lg max-h-[50vh] overflow-y-auto"
            style={
              view.pdfDisplayWidth && view.pdfDisplayWidth > 0
                ? { width: `min(${Math.round(view.pdfDisplayWidth)}px, calc(100vw - 24px))` }
                : undefined
            }
          >
            {renderInspector('dense')}
          </div>
        </div>
      )}

      {errorMsg && (
        <p className="text-sm text-red-600" role="alert">
          {errorMsg}
        </p>
      )}

      <ZoomPanel zoom={view.zoom} onZoom={view.onZoom} />

      {/* 閲覧画面戻り導線の未保存ガード共通モーダル (bbox-editor と同型)。 */}
      <UnsavedChangesModal
        open={save.leaveGuardOpen}
        description="閲覧画面に戻る前に、編集した内容を保存しますか？"
        onSave={save.handleLeaveSaveAndBack}
        onDiscard={save.handleLeaveDiscardAndBack}
        onCancel={save.closeLeaveGuard}
        saving={save.leaveSaving}
        error={save.leaveSaveError}
      />
    </div>
  )
}
