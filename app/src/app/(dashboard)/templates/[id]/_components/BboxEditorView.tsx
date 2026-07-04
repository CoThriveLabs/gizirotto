'use client'

import { MIN_BBOX_PT, type PageMeta } from '@/lib/pdf-output/bbox-coords'
import { useFieldLayerEditor } from '@/hooks/editor/useFieldLayerEditor'
import { useWhiteoutLayer } from '@/hooks/editor/useWhiteoutLayer'
import { useFixedLayer } from '@/hooks/editor/useFixedLayer'
import ErrorNotice from '@/components/error-notice'
import { UndoRedoButtons } from '@/components/editor/UndoRedoButtons'
import { UnsavedChangesModal } from '@/components/editor/UnsavedChangesModal'
import { ZoomPanel } from '@/components/editor/ZoomPanel'
import BboxPane, { type SelectionGeom } from '../bbox-pane'
import {
  fieldsToWhiteoutBoxes,
} from '@/lib/pdf-output/whiteout-adapter'
import {
  fieldsToFixedTexts,
} from '@/lib/pdf-output/fixedtext-adapter'
import { FieldControlsBody } from './FieldControlsBody'
import { FloatingNudge } from './FloatingNudge'
import { FixedTextControlsBody } from './FixedTextControlsBody'
import { FixedTextFloatingNudge } from './FixedTextFloatingNudge'
import { WhiteoutControlsBody } from './WhiteoutControlsBody'
import { WhiteoutFloatingNudge } from './WhiteoutFloatingNudge'
import { SplitNamingPanel } from './SplitNamingPanel'
import { FIELDS_MAX, type EditMode } from './editor-types'

interface BboxEditorViewProps {
  field: ReturnType<typeof useFieldLayerEditor>
  whiteout: ReturnType<typeof useWhiteoutLayer>
  fixed: ReturnType<typeof useFixedLayer>
  view: {
    mode: EditMode
    onModeChange: (m: EditMode) => void
    zoom: number
    onZoom: (z: number) => void
    showGrid: boolean
    onToggleGrid: () => void
    viewportHeight: number | undefined
    pdfDisplayWidth: number | null
    onDisplayWidth: (w: number) => void
    readOnly: boolean
  }
  data: {
    pageSizes: PageMeta[]
    imageUrls: (string | null)[]
    rawImageUrls: (string | null)[]
    selectionGeom: SelectionGeom | null
    setSelectionGeom: (g: SelectionGeom | null) => void
  }
  onBackClick: () => void
  canvasRef: React.RefObject<HTMLDivElement | null>
  isFreshClick: () => boolean
  errorMsg: string | null
  leaveGuard: {
    open: boolean
    saving: boolean
    error: string | null
    onSave: () => void
    onDiscard: () => void
    onCancel: () => void
  }
}

export default function BboxEditorView({
  field,
  whiteout,
  fixed,
  view,
  data,
  onBackClick,
  canvasRef,
  isFreshClick,
  errorMsg,
  leaveGuard,
}: BboxEditorViewProps) {
  return (
    <div className="space-y-4">
      {/* 「← 一覧へ」。未保存があれば離脱ガードのモーダルを出す（押下=handleBackClick）。 */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBackClick}
          className="text-sm text-gizirotto-blue-700 hover:underline"
        >
          ← 一覧へ
        </button>
      </div>

      {/* 記入欄/白塗り/固定テキストのモード切替トグル（同一画面・レイヤ切替）。
          切替で選択は解除（モード跨ぎの選択誤爆を防ぐ）。背景は両モード共用＝再ロードなし。 */}
      <div className="inline-flex rounded-lg border border-gray-300 bg-gray-100 p-0.5">
        {(['field', 'whiteout', 'fixed'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => view.onModeChange(m)}
            aria-pressed={view.mode === m}
            className={
              'px-4 py-2 text-sm font-medium rounded-md transition-colors ' +
              (view.mode === m
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-600 hover:text-gray-900')
            }
          >
            {m === 'field'
              ? '記入欄を編集'
              : m === 'whiteout'
                ? '白塗りを編集'
                : '固定テキスト'}
          </button>
        ))}
      </div>

      {/* PC幅で 3モードのボタン列配置を右側横並びに統一。
          説明文 <p> の長さがモードで違い flex-wrap のため長文モードだけ折り返す問題の対策:
            - 親に sm:flex-nowrap を付け、PC幅では折り返し自体を禁止（長文でも1行を維持）。
            - 説明文 <p> に sm:flex-1 sm:min-w-0 を付け、長文時は <p> 側だけが縮む（truncate なし＝
              そのまま折り返し表示でOK・縦に伸びるだけ）。ボタン列は sm:shrink-0 で縮まず右寄せ固定。
          sm 未満（スマホ）は flex-wrap のまま＝従来のモバイル挙動を完全維持（下部バー/右パネルは別系統）。 */}
      <div className="flex items-center justify-between gap-3 flex-wrap sm:flex-nowrap">
        <p className="text-sm text-gray-600 sm:flex-1 sm:min-w-0">
          {view.mode === 'whiteout'
            ? '白塗りの枠を選んでドラッグ、または下のボタン・矢印キーで 1px ずつ調整できます。記入欄は薄く参考表示しています。'
            : view.mode === 'fixed'
              ? '固定テキストの枠を選んで値を入力し、ドラッグや矢印キーで位置を調整できます。会議名・参加者など常に同じ文字を配置できます。'
              : '枠を選んでドラッグ、または下のボタン・矢印キーで 1px ずつ調整できます。'}
        </p>
        <div className="flex items-center gap-3 sm:shrink-0">
          {/* グリッド/中心線トグル。両モード共通。 */}
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

          {/* readOnly=true のとき変更操作 UI を非表示にし閲覧専用にする。 */}
          {!view.readOnly && view.mode === 'field' ? (
            <>
              {/* 戻る/進む（記入欄スタック）。配置は 3 モード共通。 */}
              <UndoRedoButtons
                onUndo={field.handleUndo}
                onRedo={field.handleRedo}
                canUndo={field.canUndo}
                canRedo={field.canRedo}
              />
              {/* 「枠を追加」。20 個で disabled＋ツールチップ。 */}
              <button
                type="button"
                onClick={field.handleAddField}
                disabled={field.fields.length >= FIELDS_MAX}
                title={field.fields.length >= FIELDS_MAX ? '枠は20個までです' : undefined}
                className="bg-white border border-gizirotto-blue-500 text-gizirotto-blue-700 hover:bg-gizirotto-blue-500/10 font-medium px-3 py-2 rounded text-sm disabled:opacity-40 disabled:cursor-not-allowed"
              >
                枠を追加
              </button>
              {/* 命名/入力の確定前は保存不可。
                  未保存バッジは廃止（スマホで見切れるため）→ 保存ボタンの活性/非活性（disabled:opacity-50）で代替。 */}
              <div className="relative">
                <button
                  type="button"
                  onClick={field.save}
                  disabled={
                    field.saving ||
                    !field.dirty ||
                    field.splitEditing !== null ||
                    field.labelEditingName !== null
                  }
                  className="bg-gizirotto-blue-500 hover:bg-gizirotto-blue-700 text-white font-medium px-3 py-2 rounded text-sm disabled:opacity-50"
                >
                  {field.saving ? '保存中…' : '保存'}
                </button>
              </div>
            </>
          ) : !view.readOnly && view.mode === 'whiteout' ? (
            <>
              {/* 戻る/進む（白塗りスタック）。配置は記入欄と同一順。 */}
              <UndoRedoButtons
                onUndo={whiteout.undo}
                onRedo={whiteout.redo}
                canUndo={whiteout.canUndo}
                canRedo={whiteout.canRedo}
              />
              {/* 白塗りを追加（命名パネルは出さない）。 */}
              <button
                type="button"
                onClick={whiteout.addBox}
                className="bg-white border border-gray-400 text-gray-700 hover:bg-gray-50 font-medium px-3 py-2 rounded text-sm"
              >
                白塗りを追加
              </button>
              {/* 白塗り保存: whiteout-apply 再利用で再焼き込み＋whiteout_boxes更新＋
                  サムネ再生成を1リクエスト。焼き込みに数秒かかるため「保存中…」表示で許容。 */}
              <div className="relative">
                <button
                  type="button"
                  onClick={whiteout.save}
                  disabled={whiteout.saving || !whiteout.dirty}
                  className="bg-gray-700 hover:bg-gray-900 text-white font-medium px-3 py-2 rounded text-sm disabled:opacity-50"
                >
                  {whiteout.saving ? '保存中…' : '保存'}
                </button>
              </div>
            </>
          ) : !view.readOnly && view.mode === 'fixed' ? (
            <>
              {/* 戻る/進む（固定テキスト独立スタック）。配置は記入欄と同一順。 */}
              <UndoRedoButtons
                onUndo={fixed.undo}
                onRedo={fixed.redo}
                canUndo={fixed.canUndo}
                canRedo={fixed.canRedo}
              />
              {/* 固定テキストを追加。生成後に右パネルで value を入力。 */}
              <button
                type="button"
                onClick={fixed.addBox}
                className="bg-white border border-gizirotto-blue-500 text-gizirotto-blue-700 hover:bg-gizirotto-blue-500/10 font-medium px-3 py-2 rounded text-sm"
              >
                固定テキストを追加
              </button>
              {/* 固定テキスト保存: fixed_texts カラムのみ更新（fields/fieldsVersion 非発火）。
                  保存ボタンは現行方式（未保存バッジ無し・dirty で活性／非dirty で opacity-50）。 */}
              <div className="relative">
                <button
                  type="button"
                  onClick={fixed.save}
                  disabled={fixed.saving || !fixed.dirty}
                  className="bg-gizirotto-blue-500 hover:bg-gizirotto-blue-700 text-white font-medium px-3 py-2 rounded text-sm disabled:opacity-50"
                >
                  {fixed.saving ? '保存中…' : '保存'}
                </button>
              </div>
            </>
          ) : null}
        </div>
      </div>

      {errorMsg && <ErrorNotice code={errorMsg} prefix="保存できませんでした" />}

      {/* レイアウト2分岐: md(768px) 以上は 2 カラム＝左 PDF / 右 固定操作パネル。
          md 未満（スマホ）は単カラム＋下部中央バー。
          起点は md(768px)。640px(sm) では右パネル 320px を引くと PDF が ~300px と窮屈で
          プレビューが読めないため、640〜768px のタブレットも 2 カラム化せず md 起点に揃えた
          （sm 起点に下げたい場合は md→sm に一括置換すれば 640px から効く）。 */}
      <div className="md:grid md:grid-cols-[minmax(0,1fr)_320px] md:gap-4 md:items-start">
      {/* キャンバス: tabIndex でフォーカスを受け keydown を拾う。
          bbox 以外（テンプレ外の水色背景=エディタ領域外含む）どこをクリックしても
          選択解除＝ウィジェットが閉じるよう、エディタ全体で bbox 外クリックを検知する。
          bbox 要素は data-box を持ち startMove/startResize で stopPropagation するため、
          ここに届くのは bbox 外クリックのみ（保険で closest('[data-box]') も判定）。
          スマホ: 下部フローティングウィジェットと被って PDF 下辺が編集不可になるのを防ぐため
          pb で余白を確保し、PDF 下辺がウィジェット上端まで来るまでスクロールできるようにする。
          md 以上は右パネル＝フローティング無しなので余白不要（md:pb-0）。 */}
      <div
        ref={canvasRef}
        tabIndex={0}
        onKeyDown={
          view.mode === 'whiteout'
            ? whiteout.onKeyDown
            : view.mode === 'fixed'
              ? fixed.onKeyDown
              : field.onKeyDown
        }
        onPointerDown={(e) => {
          if (!(e.target as HTMLElement).closest('[data-box]')) {
            // bbox 外クリックで現在モードの選択を解除（ウィジェットを閉じる）。
            if (view.mode === 'whiteout') whiteout.setSelectedName(null)
            else if (view.mode === 'fixed') fixed.setSelectedName(null)
            else field.setSelectedName(null)
          }
        }}
        className="space-y-6 outline-none focus:ring-2 focus:ring-gizirotto-blue-300 rounded pb-[60vh] md:pb-0"
      >
        {data.pageSizes.map((meta) => {
          const pageFields = field.fields.filter((f) => f.bbox.page === meta.page)
          const pageWhiteout = whiteout.fields.filter(
            (f) => f.bbox.page === meta.page,
          )
          const pageFixed = fixed.fields.filter((f) => f.bbox.page === meta.page)
          // モードで編集対象を切替。背景PNGは両モード共用＝1ロード。
          // raw 背景を全モードに渡し、canvas で「白塗り + 固定テキスト」を動的合成する。
          //   - 白塗りモード: 編集中 fields を boxes 化（既存・削除で透ける UX 維持）＋ 固定テキストは
          //     DB/編集状態の全量を canvas 重ね描画。
          //   - 固定/記入欄モード: dynamicWhiteoutBoxes = DB 保存白塗り、dynamicFixedTexts = 編集中
          //     固定テキスト（fixedFields+fixedMeta から都度組み立て＝編集即反映）。
          const rawUrl = data.rawImageUrls[meta.page - 1] ?? null
          const allFixedTexts = fieldsToFixedTexts(fixed.fields, fixed.meta)
          const allWhiteoutBoxes = fieldsToWhiteoutBoxes(whiteout.fields, whiteout.meta)
          if (view.mode === 'whiteout') {
            return (
              <BboxPane
                key={meta.page}
                meta={meta}
                imageUrl={data.imageUrls[meta.page - 1] ?? null}
                whiteoutRawImageUrl={rawUrl}
                whiteoutBgColorOf={whiteout.bgColorOf}
                fields={pageWhiteout}
                selectedName={whiteout.selectedName}
                onSelect={whiteout.setSelectedName}
                onChangeBbox={whiteout.applyBbox}
                onDragStart={whiteout.onDragStart}
                onDragCommit={whiteout.onDragCommit}
                onSelectionGeom={data.setSelectionGeom}
                zoom={view.zoom}
                viewportHeight={view.viewportHeight}
                showGrid={view.showGrid}
                variant="whiteout"
                whiteoutKindOf={whiteout.kindOf}
                onDisplayWidth={view.onDisplayWidth}
                dynamicFixedTexts={allFixedTexts}
              />
            )
          }
          if (view.mode === 'fixed') {
            // 固定テキストモード: bbox-pane を共用（whiteout モード流用＝矩形ドラッグ/選択/nudge）。
            // 見た目は記入欄と同じ青枠（variant 既定 'field'）＝値ありの枠なので青で判別しやすい。
            return (
              <BboxPane
                key={meta.page}
                meta={meta}
                imageUrl={data.imageUrls[meta.page - 1] ?? null}
                whiteoutRawImageUrl={rawUrl}
                fields={pageFixed}
                selectedName={fixed.selectedName}
                onSelect={fixed.setSelectedName}
                onChangeBbox={fixed.applyBbox}
                onDragStart={fixed.onDragStart}
                onDragCommit={fixed.onDragCommit}
                onSelectionGeom={data.setSelectionGeom}
                zoom={view.zoom}
                viewportHeight={view.viewportHeight}
                showGrid={view.showGrid}
                onDisplayWidth={view.onDisplayWidth}
                fixedTextValueOf={fixed.fixedTextValueOf}
                keepAspect
                dynamicWhiteoutBoxes={allWhiteoutBoxes}
                dynamicFixedTexts={allFixedTexts}
              />
            )
          }
          return (
            <BboxPane
              key={meta.page}
              meta={meta}
              imageUrl={data.imageUrls[meta.page - 1] ?? null}
              whiteoutRawImageUrl={rawUrl}
              fields={pageFields}
              selectedName={field.selectedName}
              onSelect={field.setSelectedName}
              onChangeBbox={field.applyBbox}
              onDragStart={field.handleFieldDragStart}
              onDragCommit={field.handleFieldDragCommit}
              onSelectionGeom={data.setSelectionGeom}
              zoom={view.zoom}
              viewportHeight={view.viewportHeight}
              showGrid={view.showGrid}
              onDisplayWidth={view.onDisplayWidth}
              dynamicWhiteoutBoxes={allWhiteoutBoxes}
              dynamicFixedTexts={allFixedTexts}
            />
          )
        })}
      </div>

      {/* md(768px) 以上の右固定パネル: フローティングをやめ常設パネルで操作。
          選択中 bbox の操作をここで行い、未選択時はプレースホルダを出す。md 未満（スマホ）は非表示。 */}
      <aside className="hidden md:block md:sticky md:top-4 self-start">
        <div className="bg-white border border-gray-200 rounded-lg px-3 py-3 shadow-sm">
          {view.mode === 'field' ? (
            (() => {
              const sel = field.fields.find((f) => f.name === field.selectedName)
              if (!field.selectedName || !sel) {
                return (
                  <p className="text-sm text-gray-500 py-8 text-center">
                    枠を選んでください
                  </p>
                )
              }
              const canSplit =
                field.fields.length < FIELDS_MAX && sel.bbox.w / 2 >= MIN_BBOX_PT
              const splitDisabledReason =
                field.fields.length >= FIELDS_MAX
                  ? '分割すると枠が20個を超えます'
                  : sel.bbox.w / 2 < MIN_BBOX_PT
                    ? '枠が小さすぎて分割できません'
                    : undefined
              return (
                <FieldControlsBody
                  onNudge={field.applyNudge}
                  onCenter={field.applyCenter}
                  onDelete={field.handleDeleteSelected}
                  canDelete={field.fields.length > 1}
                  onSplit={field.handleSplitSelected}
                  canSplit={canSplit}
                  splitDisabledReason={splitDisabledReason}
                  labelEditing={field.labelEditingName === field.selectedName}
                  labelValue={sel.label ?? ''}
                  onLabelChange={(v) => field.handleLabelChange(field.selectedName!, v)}
                  onLabelCommit={field.handleLabelCommit}
                  onStartRename={field.handleStartRenameLabel}
                  isFreshClick={isFreshClick}
                  compact
                />
              )
            })()
          ) : view.mode === 'whiteout' ? (() => {
            const sel = whiteout.selectedName
              ? whiteout.fields.find((f) => f.name === whiteout.selectedName)
              : undefined
            if (!whiteout.selectedName || !sel) {
              return (
                <p className="text-sm text-gray-500 py-8 text-center">
                  白塗りの枠を選んでください
                </p>
              )
            }
            return (
              <WhiteoutControlsBody
                onNudge={whiteout.applyNudge}
                onCenter={whiteout.applyCenter}
                onDelete={whiteout.deleteSelected}
                compact
              />
            )
          })() : (() => {
            const sel = fixed.selectedName
              ? fixed.fields.find((f) => f.name === fixed.selectedName)
              : undefined
            if (!fixed.selectedName || !sel) {
              return (
                <p className="text-sm text-gray-500 py-8 text-center">
                  固定テキストの枠を選んでください
                </p>
              )
            }
            return (
              <FixedTextControlsBody
                onNudge={fixed.applyNudge}
                onCenter={fixed.applyCenter}
                onDelete={fixed.deleteSelected}
                onSizeStep={fixed.fixedSizeStep}
                value={fixed.meta.get(fixed.selectedName)?.value ?? ''}
                onValueChange={(v) => fixed.fixedValueChange(fixed.selectedName!, v)}
                compact
              />
            )
          })()}
        </div>
      </aside>
      </div>

      {/* 白塗りモードのフローティング nudge: 移動/中央寄せ/削除。
          命名パネル・分割は出さない（分割なし仕様）。
          md 未満（スマホ）=PDF幅追従の下部中央バー（幅追従スケール）。
          md 以上（タブレット＋PC）は右パネルへ集約＝フローティング自体が消える（FloatingShell）。 */}
      {view.mode === 'whiteout' && whiteout.selectedName && (() => {
        const sel = whiteout.fields.find((f) => f.name === whiteout.selectedName)
        return (
          <WhiteoutFloatingNudge
            onNudge={whiteout.applyNudge}
            onCenter={whiteout.applyCenter}
            onDelete={whiteout.deleteSelected}
            pdfWidth={view.pdfDisplayWidth}
            key={sel?.name}
          />
        )
      })()}

      {/* 固定テキストモードのフローティング nudge: 値入力＋移動/中央寄せ/削除。
          md 未満（スマホ）=PDF幅追従の下部中央バー。md 以上は右パネルへ集約＝フローティング消える。 */}
      {view.mode === 'fixed' && fixed.selectedName && (() => {
        const sel = fixed.fields.find((f) => f.name === fixed.selectedName)
        return (
          <FixedTextFloatingNudge
            onNudge={fixed.applyNudge}
            onCenter={fixed.applyCenter}
            onDelete={fixed.deleteSelected}
            onSizeStep={fixed.fixedSizeStep}
            value={fixed.meta.get(fixed.selectedName)?.value ?? ''}
            onValueChange={(v) => fixed.fixedValueChange(fixed.selectedName!, v)}
            pdfWidth={view.pdfDisplayWidth}
            key={sel?.name}
          />
        )
      })()}

      {/* フローティング nudge: 選択中のみ表示。
          md 未満（スマホ）=PDF幅追従の下部中央バー（幅追従スケールで3カラム維持）／
          md 以上（タブレット＋PC）=右固定パネル。 */}
      {view.mode === 'field' && field.selectedName && (() => {
        const sel = field.fields.find((f) => f.name === field.selectedName)
        // B-4 分割可否: 件数 19 未満（+1 で 20 以内）かつ半分が最小幅以上。
        const canSplit =
          !!sel &&
          field.fields.length < FIELDS_MAX &&
          sel.bbox.w / 2 >= MIN_BBOX_PT
        // disabled 理由（ツールチップ）: 件数優先、次に最小幅。
        const splitDisabledReason =
          sel && field.fields.length >= FIELDS_MAX
            ? '分割すると枠が20個を超えます'
            : sel && sel.bbox.w / 2 < MIN_BBOX_PT
              ? '枠が小さすぎて分割できません'
              : undefined
        return (
          <FloatingNudge
            onNudge={field.applyNudge}
            onCenter={field.applyCenter}
            onDelete={field.handleDeleteSelected}
            canDelete={field.fields.length > 1}
            onSplit={field.handleSplitSelected}
            canSplit={canSplit}
            splitDisabledReason={splitDisabledReason}
            labelEditing={field.labelEditingName === field.selectedName}
            labelValue={sel?.label ?? ''}
            onLabelChange={(v) => field.handleLabelChange(field.selectedName!, v)}
            onLabelCommit={field.handleLabelCommit}
            onStartRename={field.handleStartRenameLabel}
            isFreshClick={isFreshClick}
            pdfWidth={view.pdfDisplayWidth}
          />
        )
      })()}

      {/* 分割直後の 2 枠同時命名パネル。
          左右それぞれに label 入力欄を出し、元 label をプレースホルダ参考表示する。
          区切り文字での機械自動分割はしない（誤分割防止）。確定で両未入力は項目N仮置き。 */}
      {field.splitEditing && (
        <SplitNamingPanel
          leftValue={
            field.fields.find((f) => f.name === field.splitEditing!.leftName)?.label ?? ''
          }
          rightValue={
            field.fields.find((f) => f.name === field.splitEditing!.rightName)?.label ?? ''
          }
          origLabel={field.splitEditing.origLabel}
          onLeftChange={(v) => field.handleSplitLabelChange(field.splitEditing!.leftName, v)}
          onRightChange={(v) => field.handleSplitLabelChange(field.splitEditing!.rightName, v)}
          onCommit={field.handleSplitCommit}
        />
      )}

      {/* 削除 告知トースト: 削除直後に一定時間表示。「元に戻す」=汎用 handleUndo を呼ぶ。
          トーストが消えても undoStack は残る＝8秒過ぎても ↩/Ctrl+Z で戻せる。
          スマホ下部 nudge バー（bottom-0）と被らないよう bottom を上げる。 */}
      {field.deleteToast && (
        <div
          role="status"
          className="fixed inset-x-0 bottom-24 sm:bottom-8 z-50 flex justify-center px-3 pointer-events-none"
        >
          <div className="pointer-events-auto flex items-center gap-3 bg-gray-900/95 text-white text-sm rounded-full pl-4 pr-2 py-2 shadow-lg">
            <span>枠を削除しました（戻るで取り消せます）</span>
            <button
              type="button"
              onClick={field.handleUndoDelete}
              className="font-medium px-3 py-1 rounded-full bg-white/15 hover:bg-white/25"
            >
              元に戻す
            </button>
          </div>
        </div>
      )}

      {/* ズームパネル（右下固定）。[−]/スライダー/[+]/倍率%。 */}
      <ZoomPanel zoom={view.zoom} onZoom={view.onZoom} />

      {/* 「一覧へ」離脱時の未保存セーフガード・モーダル。
          データ損失防止＝保存して移動 / 保存せず移動 / キャンセル の 3 択。
          共通モーダル化により Esc / 初期 focus / 背景クリック閉じが自動付与（a11y 副次改善）。 */}
      <UnsavedChangesModal
        open={leaveGuard.open}
        description="一覧へ戻る前に、編集した内容を保存しますか？"
        onSave={leaveGuard.onSave}
        onDiscard={leaveGuard.onDiscard}
        onCancel={leaveGuard.onCancel}
        saving={leaveGuard.saving}
        error={leaveGuard.error}
      />
    </div>
  )
}
