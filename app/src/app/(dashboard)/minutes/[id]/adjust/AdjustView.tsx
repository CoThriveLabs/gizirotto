'use client'

/**
 * 統合 AdjustView — 議事録の値入力 + bbox 位置 / サイズ調整画面。
 *
 * 編集状態（値 / 位置 / サイズ / 整形 / 項目追加削除 / undo-redo）は useMinuteAdjustEditor hook に
 * 集約し、本体（Container）は「タイトル / 開催日 + 周辺 state + 各 hook 呼び出し + renderInspector」
 * を持つ。ready 時の JSX は AdjustViewLayout（Presenter）へ委譲する。
 *
 * UI 構造（templates bbox-editor-client.tsx 踏襲）:
 *   - PC（md+）: 2 カラム grid（プレビュー + 右 aside 固定パネル）。
 *   - スマホ / タブ縦（md 未満）: FloatingShell 下部中央バー。
 *   - 同一 Inspector body（MinutesFieldInspector）を PC=compact / スマホ=dense で props 切替。
 *
 * 動的プレビュー（焼き込み禁止）:
 *   - 背景 = /api/minutes/[id]/render-image を raw=true で叩く（記入値ゼロの PNG）。
 *   - 文字レイヤ = BboxPane.dynamicFieldValues + compositeFieldValuesOnCanvas で都度合成。
 *
 * サーバ専用 import 分離: field-override / uniform-size / bbox-coords /
 * field-values-composite-canvas は pdf-lib/canvas を持たない pure。本体も同じ pure を import し、
 * ブラウザバンドルにネイティブ依存が混入しない。
 */
import { useEffect, useRef, useState } from 'react'
import {
  type BboxOverrides,
} from '@/lib/pdf-output/field-override'
import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'
import type { SelectionGeom } from '@/app/(dashboard)/templates/[id]/bbox-pane'
import { MinutesFieldInspector } from './_components/MinutesFieldInspector'
import { useToast } from '@/components/toast/toast-context'
import { useMinuteAdjustEditor } from '@/hooks/editor/useMinuteAdjustEditor'
import type { UseGuestTurnstileGate } from '@/hooks/useGuestTurnstileGate'
import {
  type TemplateFieldDef,
} from './adjust-view-helpers'
import { useAdjustViewData } from './use-adjust-view-data'
import { useAdjustFormatting } from './use-adjust-formatting'
import { useMinuteSaveLifecycle } from './use-minute-save-lifecycle'
import AdjustViewLayout from './_components/AdjustViewLayout'

interface Props {
  minuteId: string
  templateId: string
  /**
   * AdjustView ヘッダーのタイトル / 開催日 input 初期値。lazy create 直後は
   * 「テンプレ名 / 今日」のダミー値、既存議事録閲覧時は DB 既存値。
   * 編集 → dirty → 保存ボタン経路で updateMinute（title/meetingDate optional）を呼ぶ。
   */
  initialTitle: string
  initialMeetingDate: string
  fields: TemplateFieldDef[]
  /**
   * テンプレ DB の実 PdfField[]。実テンプレの padding / font.size / multiline / font_size_min を
   * 受け取り、canvas 経路の wrap maxW を PDF 経路（regenerate-minute-pdf → overlay-generator）と
   * 完全同型化する。順序・name 集合は fields（TemplateFieldDef[]）と一致する前提。
   * fields 配列が変わる操作（項目削除・undo）では pdfFields を name で再ルックアップする。
   */
  pdfFields: PdfField[]
  initialOverrides: BboxOverrides
  initialValues: Record<string, string>
  /**
   * テンプレ固定テキスト（templates.fixed_texts）の font.size 群（pt）。
   * computeUniformFontSize の snap 入力としてプレビュー（canvas 経路）に渡し、
   * PDF / 画像経路と同じ snap 結果を得る。未指定 / 空配列なら snap 無効＝後方互換。
   */
  fixedTextSizesPt?: number[]
  /**
   * true のときゲストモード（既定 false・未指定時はログインユーザー経路と完全不変）。
   * 保存ボタンは DB へ書き込まず onGuestSave のみ呼ぶ。背景 / pageSizes 取得も
   * 認証必須 route を経由せず renderImageEndpoint / 固定 A4 を使う。
   */
  guestMode?: boolean
  /** 背景 / selected-only PNG の取得先 URL（既定: 既存 /api/minutes/[id]/render-image）。 */
  renderImageEndpoint?: string
  /** guestMode 時の保存ボタン押下で呼ばれる。draft の永続化先（form-cache 等）は呼出側の責務。 */
  onGuestSave?: (draft: GuestMinuteDraft) => void
  /**
   * guestMode 時に format-item route へ Turnstile トークンを乗せるゲート。呼出側
   * （GuestAdjustBootstrap）が TurnstileWidget を保持し、その onToken をこの gate に接続する。
   * 未指定 = ログインユーザー経路（body に turnstileToken フィールドを一切含めない）。
   */
  guestTurnstileGate?: UseGuestTurnstileGate
}

/**
 * guestMode 保存ボタンが onGuestSave へ渡す draft 形。ログイン後の本保存（createMinute 相当）に
 * 必要な最小集合: テンプレ・タイトル・開催日・記入値・bbox 上書き・追加 field。
 */
export type GuestMinuteDraft = {
  templateId: string
  title: string
  meetingDate: string
  content: Record<string, string>
  overrides: BboxOverrides
  newFields?: PdfField[]
}

/** FloatingShell 幅追従スケール基準（templates `widthToScale` 同方式）。 */
const FLOATING_BASE_WIDTH_PX = 470

function widthToScale(effectiveWidth: number): number {
  const s = effectiveWidth / FLOATING_BASE_WIDTH_PX
  return Math.max(0.5, Math.min(1, s))
}

export function AdjustView({
  minuteId,
  templateId,
  initialTitle,
  initialMeetingDate,
  fields: initialFields,
  pdfFields,
  initialOverrides,
  initialValues,
  fixedTextSizesPt,
  guestMode,
  renderImageEndpoint,
  onGuestSave,
  guestTurnstileGate,
}: Props) {
  const { showToast } = useToast()

  // chat 振分失敗時 warning を初回マウントで toast 表示し sessionStorage 消費（1 回のみ）。
  useEffect(() => {
    if (typeof window === 'undefined') return
    const warning = sessionStorage.getItem('minutes:draft-warning')
    if (!warning) return
    sessionStorage.removeItem('minutes:draft-warning')
    showToast('warning', warning)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── 本体維持 state（タイトル / 開催日 + プレゼンテーション層）──────────────
  const [title, setTitle] = useState<string>(initialTitle)
  const [meetingDate, setMeetingDate] = useState<string>(initialMeetingDate)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pdfDisplayWidth, setPdfDisplayWidth] = useState<number | null>(null)
  const [showGrid, setShowGrid] = useState(false)
  // selectionGeom は BboxPane が内部的にラベル左上表示に使うほか、AdjustViewLayout の
  // スマホ用モーダル自動スクロール（選択枠がモーダルに隠れないための scrollBy 計算）にも使う。
  const [selectionGeom, setSelectionGeom] = useState<SelectionGeom | null>(null)

  // textarea ref は BboxPane と Inspector の両方が触るため本体管理。autoFocus effect は hook 内。
  const textareaRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null)

  // ── 背景 raw PNG / previewFont / pageSizes の取得 effect 群 ──────────────
  const { rawBgUrl, pageSizes, previewFont } = useAdjustViewData({
    minuteId,
    templateId,
    guestMode,
    renderImageEndpoint,
  })

  // ── エディタ状態（値 / 位置 / サイズ / undo-redo / 項目操作）を hook へ集約 ──
  const editor = useMinuteAdjustEditor({
    minuteId,
    initialFields,
    initialValues,
    initialOverrides,
    pdfFields,
    fixedTextSizesPt,
    pageSizes,
    previewFont,
    textareaRef,
    guestMode,
  })

  // 整形 SSE（tone/custom）。tones/customTexts も本 hook が保持する。
  const formatting = useAdjustFormatting({
    editor,
    guestTurnstileGate,
    setErrorMsg,
    initialFields,
  })

  // dirty = エディタ部（hook）+ タイトル / 開催日（本体）の boolean OR。
  // metaDirty は文字列比較 2 回なので hot path 化しない（useMemo すら不要）。
  const metaDirty = title !== initialTitle || meetingDate !== initialMeetingDate
  const dirty = editor.dirty || metaDirty

  // 保存ライフサイクル（本保存 / 離脱ガード保存・破棄）。
  const save = useMinuteSaveLifecycle({
    minuteId,
    templateId,
    guestMode,
    onGuestSave,
    title,
    meetingDate,
    metaDirty,
    buildSavePayload: editor.buildSavePayload,
    setErrorMsg,
  })

  const selectedField = editor.selected
    ? editor.fields.find((f) => f.name === editor.selected) ?? null
    : null
  const selectedOverride = editor.selected
    ? editor.overrides[editor.selected]
    : undefined
  const selectedFontSize = selectedOverride?.fontSize

  // FloatingShell 用の幅追従スケール（スマホ下バー）。
  const phoneScale =
    pdfDisplayWidth && pdfDisplayWidth > 0
      ? widthToScale(pdfDisplayWidth - 20)
      : 1

  // 閲覧画面戻り導線の未保存ガード: dirty=true なら共通モーダル展開、dirty=false なら通常遷移。
  function handleBackToViewerClick(e: React.MouseEvent<HTMLAnchorElement>) {
    if (!dirty) return
    e.preventDefault()
    save.openLeaveGuard()
  }

  // PC（compact）/ スマホ（dense+scale）で共通の Inspector body。variant 固有差分のみ分岐する。
  function renderInspector(variant: 'compact' | 'dense') {
    if (!selectedField) return null
    const variantProps =
      variant === 'compact'
        ? { compact: true as const }
        : { dense: true as const, scale: phoneScale }
    return (
      <MinutesFieldInspector
        field={selectedField}
        value={editor.values[selectedField.name] ?? ''}
        onValueChange={(v) => editor.onValueChange(selectedField.name, v)}
        tone={formatting.tones[selectedField.name] ?? 'omakase'}
        onToneChange={(t) =>
          formatting.setTones((prev) => ({ ...prev, [selectedField.name]: t }))
        }
        customText={formatting.customTexts[selectedField.name] ?? ''}
        onCustomTextChange={(v) =>
          formatting.setCustomTexts((prev) => ({
            ...prev,
            [selectedField.name]: v.slice(0, 200),
          }))
        }
        onFormat={() => formatting.onFormat(selectedField.name)}
        formatting={formatting.formatting === selectedField.name}
        fontSize={selectedFontSize}
        onFontSizeStep={editor.onFontSizeStep}
        onFontSizeReset={editor.onFontSizeReset}
        onDelete={editor.handleDeleteSelected}
        canDelete={editor.fields.length > 1}
        onNudge={editor.applyNudgeAction}
        onCenter={editor.applyCenterHorizontal}
        textareaRef={textareaRef}
        labelEditing={editor.labelEditingName === selectedField.name}
        onLabelChange={(v) => editor.handleLabelChange(selectedField.name, v)}
        onLabelCommit={editor.handleLabelCommit}
        {...variantProps}
      />
    )
  }

  return (
    <AdjustViewLayout
      editor={editor}
      save={save}
      header={{
        title,
        onTitleChange: setTitle,
        meetingDate,
        onMeetingDateChange: setMeetingDate,
        guestMode,
        minuteId,
        onBackToViewerClick: handleBackToViewerClick,
        dirty,
      }}
      view={{
        zoom,
        onZoom: setZoom,
        showGrid,
        onToggleGrid: () => setShowGrid((v) => !v),
        pdfDisplayWidth,
        onDisplayWidth: setPdfDisplayWidth,
        previewFont,
        pageSizes,
        rawBgUrl,
        setSelectionGeom,
        selectionGeom,
      }}
      errorMsg={errorMsg}
      selectedField={selectedField}
      renderInspector={renderInspector}
    />
  )
}
