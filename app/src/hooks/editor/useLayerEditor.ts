'use client'

/**
 * 白塗り/固定テキスト レイヤ共通の編集ロジックを束ねる総称 custom hook。
 *
 * LayerSnapshot<TMeta>（undo-stack.ts）を土台にし、whiteout/fixed 2 層が共有する以下を内包する:
 *   - fields / meta / selectedName / snapshot / saving / undoStack / redoStack の state
 *   - *FieldsRef / *MetaRef / *UndoStackRef / *RedoStackRef の最新参照ミラー
 *   - dragPreRef
 *   - snapshotNow / pushUndo / handleUndo / handleRedo
 *   - onDragStart / onDragCommit
 *   - applyBbox / applyNudge / applyCenter / addBox / deleteSelected
 *   - dirty の useMemo（serialize 注入・生値計算禁止）
 *   - commitSaved / init / setFields / setMeta
 *
 * 不変条件（壊すと undo 取りこぼしの温床）:
 *   - dragPreRef + onDragStart + onDragCommit + snapshotNow + ref ミラーは必ず同一 hook 内同居
 *     （退避→確定の同期を保つ）。
 *   - ref ミラーの代入は hook body トップレベル（useEffect にすると退避が 1 フレーム古くなる）。
 *   - dirty は useMemo のまま返す（生値で都度 serialize すると親再レンダーごとに hot path 化）。
 *
 * 固有ロジック（kindOf / bgColorOf / value coalesce / onKeyDown / save）は
 * 薄ラッパ（useWhiteoutLayer / useFixedLayer）で実装する。
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import {
  type PageMeta,
  type BboxPt,
  centeredNewBbox,
} from '@/lib/pdf-output/bbox-coords'
import {
  type LayerSnapshot,
  pushLayerSnapshot,
  popLayerSnapshot,
} from '@/lib/pdf-output/undo-stack'
import type { EditorField } from '@/app/(dashboard)/templates/[id]/bbox-pane'
import type { NudgeAction } from '@/app/(dashboard)/templates/[id]/nudge-controls'
import { nudgeSelected, centerSelected } from '@/hooks/editor/layer-ops'

export interface UseLayerEditorParams<TMeta> {
  pageSizes: PageMeta[]
  /** 追加枠の name 採番（wo_N / ft_N の差を注入）。 */
  nextName: (used: Set<string>) => string
  /** 追加枠の既定 meta（白=不透明白 / 固定=空 value+既定 font の差を注入）。 */
  makeDefaultMeta: () => TMeta
  /**
   * dirty 判定のシリアライズ（serializeWhiteout / serializeFixed の差を注入）。
   * hook 外のモジュール関数を渡すこと（JSON.stringify を含む計算を hook 内に閉じない）。
   */
  serialize: (fields: EditorField[], meta: Map<string, TMeta>) => string
}

export interface UseLayerEditorReturn<TMeta> {
  fields: EditorField[]
  meta: Map<string, TMeta>
  selectedName: string | null
  setSelectedName: React.Dispatch<React.SetStateAction<string | null>>
  dirty: boolean
  saving: boolean
  canUndo: boolean
  canRedo: boolean
  // 操作（適用前 push を内包）
  applyBbox: (name: string, bbox: BboxPt & { page: number }) => void
  applyNudge: (action: NudgeAction) => void
  applyCenter: () => void
  addBox: () => void
  deleteSelected: () => void
  // 履歴
  undo: () => void
  redo: () => void
  // ドラッグ
  onDragStart: () => void
  onDragCommit: (name: string, changed: boolean) => void
  // 保存ライフサイクル（保存成功で snapshot 更新 + 履歴クリア）
  commitSaved: (keptFields: EditorField[], keptMeta: Map<string, TMeta>) => void
  // 初期化（初回ロード effect から）
  init: (fields: EditorField[], meta: Map<string, TMeta>) => void
  // 直接 setter（固有ロジックが state を触る用）
  setFields: React.Dispatch<React.SetStateAction<EditorField[]>>
  setMeta: React.Dispatch<React.SetStateAction<Map<string, TMeta>>>
  setSaving: React.Dispatch<React.SetStateAction<boolean>>
  /** 操作適用前に直前 snapshot を push する（固有ロジックが undo を積む用・fixedSizeStep 等）。 */
  pushUndo: () => void
}

export function useLayerEditor<TMeta>(
  params: UseLayerEditorParams<TMeta>,
): UseLayerEditorReturn<TMeta> {
  const { pageSizes, nextName, makeDefaultMeta, serialize } = params

  const [fields, setFields] = useState<EditorField[]>([])
  const [meta, setMeta] = useState<Map<string, TMeta>>(new Map())
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<string>('')
  const [saving, setSaving] = useState(false)

  const [undoStack, setUndoStack] = useState<LayerSnapshot<TMeta>[]>([])
  const [redoStack, setRedoStack] = useState<LayerSnapshot<TMeta>[]>([])

  // 最新参照ミラー（hook body トップレベルで代入・useEffect にしない）。
  // pushUndo / snapshotNow が依存配列を増やさず最新 state を読む。
  const fieldsRef = useRef(fields)
  fieldsRef.current = fields
  const metaRef = useRef(meta)
  metaRef.current = meta

  // undo/redo を updater 外で実行（StrictMode の updater 二重呼び出しでも安全に保つ）。
  const undoStackRef = useRef(undoStack)
  undoStackRef.current = undoStack
  const redoStackRef = useRef(redoStack)
  redoStackRef.current = redoStack

  /** 現在の編集 state を LayerSnapshot へ（meta は配列化）。 */
  const snapshotNow = useCallback((): LayerSnapshot<TMeta> => ({
    fields: fieldsRef.current,
    meta: [...metaRef.current.entries()],
  }), [])

  /** 操作の適用前に直前 snapshot を push（redo はクリア）。 */
  const pushUndo = useCallback(() => {
    const before = snapshotNow()
    setUndoStack((s) => pushLayerSnapshot(s, before))
    setRedoStack((r) => (r.length === 0 ? r : []))
  }, [snapshotNow])

  /** 戻る（undo）: pop → 適用、現在状態を redo へ退避。選択は解除。 */
  const undo = useCallback(() => {
    const { snap, rest } = popLayerSnapshot(undoStackRef.current)
    if (!snap) return
    const before = snapshotNow()
    setFields(snap.fields)
    setMeta(new Map(snap.meta))
    setSelectedName(null)
    setUndoStack(rest)
    setRedoStack((r) => pushLayerSnapshot(r, before))
  }, [snapshotNow])

  /** 進む（redo）: redo pop → 適用、現在状態を undo へ。選択は解除。 */
  const redo = useCallback(() => {
    const { snap, rest } = popLayerSnapshot(redoStackRef.current)
    if (!snap) return
    const before = snapshotNow()
    setFields(snap.fields)
    setMeta(new Map(snap.meta))
    setSelectedName(null)
    setRedoStack(rest)
    setUndoStack((u) => pushLayerSnapshot(u, before))
  }, [snapshotNow])

  // ドラッグの undo は「開始時は退避だけ・確定時に bbox が変化した場合のみ push」
  //（クリック＝選択のみ（移動量0）で undo を誤有効化しないため）。
  const dragPreRef = useRef<LayerSnapshot<TMeta> | null>(null)

  /** ドラッグ開始: ドラッグ前 snapshot を退避（push はしない）。 */
  const onDragStart = useCallback(() => {
    dragPreRef.current = snapshotNow()
  }, [snapshotNow])

  /** ドラッグ確定: 実際に bbox が変化したときだけ退避 snapshot を push（1ドラッグ=1ステップ）。 */
  const onDragCommit = useCallback((_name: string, changed: boolean) => {
    const pre = dragPreRef.current
    dragPreRef.current = null
    if (!changed || !pre) return // クリックのみ（移動量0）は push せず「戻る」を誤有効化しない。
    setUndoStack((s) => pushLayerSnapshot(s, pre))
    setRedoStack((r) => (r.length === 0 ? r : []))
  }, [])

  const applyBbox = useCallback(
    (name: string, bbox: BboxPt & { page: number }) => {
      setFields((prev) =>
        prev.map((f) => (f.name === name ? { ...f, bbox } : f)),
      )
    },
    [],
  )

  const applyNudge = useCallback(
    (action: NudgeAction) => {
      nudgeSelected(setFields, selectedName, pageSizes, action, pushUndo)
    },
    [selectedName, pageSizes, pushUndo],
  )

  const applyCenter = useCallback(() => {
    centerSelected(setFields, selectedName, pageSizes, pushUndo)
  }, [selectedName, pageSizes, pushUndo])

  const addBox = useCallback(() => {
    if (pageSizes.length === 0) return
    pushUndo()
    const selected = fieldsRef.current.find((f) => f.name === selectedName)
    const targetPage = selected ? selected.bbox.page : pageSizes[0].page
    const pageMeta = pageSizes.find((p) => p.page === targetPage) ?? pageSizes[0]
    const used = new Set(fieldsRef.current.map((f) => f.name))
    const name = nextName(used)
    const newField: EditorField = {
      name,
      label: '',
      bbox: centeredNewBbox(pageMeta),
    }
    setFields((prev) => [...prev, newField])
    setMeta((prev) => {
      const next = new Map(prev)
      next.set(name, makeDefaultMeta())
      return next
    })
    setSelectedName(name)
  }, [pageSizes, selectedName, pushUndo, nextName, makeDefaultMeta])

  const deleteSelected = useCallback(() => {
    if (!selectedName) return
    const name = selectedName
    pushUndo()
    setFields((prev) => prev.filter((f) => f.name !== name))
    setMeta((prev) => {
      if (!prev.has(name)) return prev
      const next = new Map(prev)
      next.delete(name)
      return next
    })
    setSelectedName(null)
  }, [selectedName, pushUndo])

  /**
   * dirty は hook 内 useMemo で返す（deps は fields / meta / snapshot の変化時のみ）。
   * serialize を hook 外に置き、レンダーごとに serialize を直接呼ばないことで hot path 化を防ぐ。
   */
  const dirty = useMemo(
    () => snapshot !== '' && serialize(fields, meta) !== snapshot,
    [fields, meta, snapshot, serialize],
  )

  /** 保存成功後に呼ぶ。snapshot 更新 + 履歴クリア + selectedName 解除。 */
  const commitSaved = useCallback(
    (keptFields: EditorField[], keptMeta: Map<string, TMeta>) => {
      setFields(keptFields)
      setMeta(keptMeta)
      setSelectedName(null)
      setSnapshot(serialize(keptFields, keptMeta))
      setUndoStack([])
      setRedoStack([])
    },
    [serialize],
  )

  /** 初期化（初回ロード effect から呼ぶ）。 */
  const init = useCallback(
    (initFields: EditorField[], initMeta: Map<string, TMeta>) => {
      setFields(initFields)
      setMeta(initMeta)
      setSelectedName(null)
      setSnapshot(serialize(initFields, initMeta))
      setUndoStack([])
      setRedoStack([])
    },
    [serialize],
  )

  return {
    fields,
    meta,
    selectedName,
    setSelectedName,
    dirty,
    saving,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    applyBbox,
    applyNudge,
    applyCenter,
    addBox,
    deleteSelected,
    undo,
    redo,
    onDragStart,
    onDragCommit,
    commitSaved,
    init,
    setFields,
    setMeta,
    setSaving,
    pushUndo,
  }
}
