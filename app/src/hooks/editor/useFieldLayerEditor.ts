'use client'

/**
 * 記入欄（field）レイヤの編集ロジックを束ねる custom hook。
 *
 * bbox-editor-client.tsx の field 層 state/ref/effect/handler を移送したもの。
 * 白塗り/固定の総称 useLayerEditor とは別シグネチャ（field 固有の以下を内包するため）:
 *   - EditSnapshot（fields + newFieldNames + labelDirtyNames の 3 点 1 組）
 *   - nudge coalesce（lastPushRef + shouldCoalesceNudge・同一 selectedName×600ms 連続を1ステップに集約）
 *   - 分割の 2 枠同時命名（splitEditing）・label インライン編集（labelEditingName）・削除告知トースト
 *
 * 不変条件（壊すと undo regression / 取りこぼしの温床）:
 *   - lastPushRef + pushUndo + applySnapshot + handleFieldDragCommit + save の履歴クリア部は同一 hook 内同居
 *     （coalesce 連鎖の遮断タイミングを保つ）。
 *   - dragPreSnapshotRef + handleFieldDragStart + handleFieldDragCommit + currentSnapshot + ref ミラー
 *     （fieldsRef/newFieldNamesRef/labelDirtyNamesRef）は同一 hook 内同居（退避→確定の同期を保つ）。
 *   - ref ミラーの代入は hook body トップレベル（useEffect にしない＝1 フレーム遅れを防ぐ）。
 *   - dirty は useMemo のまま返す（生値で都度 JSON.stringify すると親再レンダーごとに hot path 化）。
 *
 * armedAtRef / selectionGeom / isFreshClick は複数層横断のため本体維持。本 hook は selectedName を
 * 返り値に含め、本体がそれを armedAt 更新 effect の deps に使う。selectionGeom のリセットだけは
 * applySnapshot / handleSplitSelected が行うため setSelectionGeom を params で受け取る。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type PageMeta,
  type BboxPt,
  centeredNewBbox,
  splitVertical,
  MIN_BBOX_PT,
} from '@/lib/pdf-output/bbox-coords'
import {
  type EditSnapshot,
  pushSnapshot,
  popSnapshot,
  shouldCoalesceNudge,
} from '@/lib/pdf-output/undo-stack'
import { updateTemplateFieldsBbox } from '@/server/templates'
import type { EditorField, SelectionGeom } from '@/app/(dashboard)/templates/[id]/bbox-pane'
import type { NudgeAction } from '@/app/(dashboard)/templates/[id]/nudge-controls'
import { nudgeSelected, centerSelected } from '@/hooks/editor/layer-ops'
import {
  nextClientFieldName,
  placeholderLabel,
} from '@/lib/pdf-output/bbox-save'

/** fields 配列の上限（サーバ FIELDS_MAX と一致）。20 で「枠を追加」disabled。 */
const FIELDS_MAX = 20

/** label の最大文字数（サーバ LABEL_MAX と一致）。入力時点で制限。 */
const LABEL_MAX = 40

export interface SplitEditing {
  leftName: string
  rightName: string
  /** 分割元 field の label（左右の入力欄プレースホルダに参考表示）。 */
  origLabel: string
}

export interface UseFieldLayerEditorParams {
  templateId: string
  pageSizes: PageMeta[]
  /** selectionGeom は本体維持（全層共通）。applySnapshot / 分割でリセットするため setter を受け取る。 */
  setSelectionGeom: (g: SelectionGeom | null) => void
  /**
   * fieldsVersion は本体維持（初期データ・全層共有 state）。field 保存の楽観ロックに使うため
   * 読み取り（getFieldsVersion）と保存成功時の更新（setFieldsVersion）を本体から注入する。
   * whiteout/固定はカラム独立保存で fieldsVersion を使わない（field 保存固有）。
   */
  getFieldsVersion: () => string
  setFieldsVersion: (v: string) => void
  /**
   * エラー表示は本体の単一 errorMsg（3 モード共通の <ErrorNotice>）に集約するため、save 失敗時の
   * エラーコードを本体へ通知する setter を注入する（hook 内に errorMsg state を二重に持たない）。
   */
  setBodyErrorMsg: (msg: string | null) => void
}

export interface UseFieldLayerEditor {
  fields: EditorField[]
  selectedName: string | null
  setSelectedName: (name: string | null) => void
  newFieldNames: Set<string>
  labelEditingName: string | null
  labelDirtyNames: Set<string>
  splitEditing: SplitEditing | null
  snapshot: string
  saving: boolean
  dirty: boolean
  canUndo: boolean
  canRedo: boolean
  deleteToast: boolean
  // 操作（適用前 push を内包）
  applyBbox: (name: string, bbox: BboxPt & { page: number }) => void
  applyNudge: (action: NudgeAction) => void
  applyCenter: () => void
  handleAddField: () => void
  handleSplitSelected: () => void
  handleSplitLabelChange: (name: string, value: string) => void
  handleSplitCommit: () => void
  handleStartRenameLabel: () => void
  handleLabelChange: (name: string, value: string) => void
  handleLabelCommit: () => void
  handleDeleteSelected: () => void
  handleUndoDelete: () => void
  // ドラッグ
  handleFieldDragStart: (name: string) => void
  handleFieldDragCommit: (name: string, changed: boolean) => void
  // 履歴
  handleUndo: () => void
  handleRedo: () => void
  // キーボード
  onKeyDown: (e: React.KeyboardEvent) => void
  // 保存（DB 反映まで await・成功 true / 失敗 false）。離脱ガードの一括保存からも呼ぶ。
  save: () => Promise<boolean>
  // 初期化（初回ロード effect から）。fields/snapshot 確定＋履歴・採番集合・選択を初期状態へ。
  init: (fields: EditorField[], snapshot: string) => void
}

export function useFieldLayerEditor(
  params: UseFieldLayerEditorParams,
): UseFieldLayerEditor {
  const {
    templateId,
    pageSizes,
    setSelectionGeom,
    getFieldsVersion,
    setFieldsVersion,
    setBodyErrorMsg,
  } = params

  const [fields, setFields] = useState<EditorField[]>([])
  const [selectedName, setSelectedName] = useState<string | null>(null)

  // クライアント新規（DB に無い）枠の name 集合。追加した枠の楽観 name（field_N）をここに入れ、
  // 保存時にこの集合の枠を isNew:true で送る（サーバ INSERT＋属性デフォルト補完＋採番再確定）。
  const [newFieldNames, setNewFieldNames] = useState<Set<string>>(new Set())

  // 生成直後の label インライン入力対象 name。null で非表示。
  const [labelEditingName, setLabelEditingName] = useState<string | null>(null)

  // 既存 field のうち label を差替えて保存する name 集合（分割左枠＝元 field）。保存時に
  // labelDirty:true で送る（サーバが「既存 label は温存」の例外として label のみ差替）。
  // 🚨 labelDirty と isNew は排他: 左枠は labelDirty（既存・label差替）、右枠は isNew（新規）。
  const [labelDirtyNames, setLabelDirtyNames] = useState<Set<string>>(new Set())

  // 分割直後の 2 枠同時命名。縦に2分割を押すと左右2枠を生成し、両枠の label をまとめて入力させる。
  // 元 label はプレースホルダ表示（参考）。両未入力確定なら「項目N」「項目N+1」仮置き。
  const [splitEditing, setSplitEditing] = useState<SplitEditing | null>(null)

  // 「変更あり」判定用の初期スナップショット（JSON 文字列で比較）。
  const [snapshot, setSnapshot] = useState<string>('')
  const [saving, setSaving] = useState(false)

  // スナップショット・スタック方式の undo/redo。
  //   - undoStack: 過去状態（トップ=「1つ前」）。各操作の適用前に直前 snapshot を push。
  //   - redoStack: undo で退避した状態。新規操作で必ずクリア（標準 undo/redo）。
  //   snapshot は {fields, newFieldNames(配列), labelDirtyNames(配列)} の3点1組。
  //   UI 一時状態（selectedName/labelEditingName/splitEditing/selectionGeom）は履歴に含めない。
  const [undoStack, setUndoStack] = useState<EditSnapshot[]>([])
  const [redoStack, setRedoStack] = useState<EditSnapshot[]>([])

  // nudge coalesce 判定用: 直前 push の種別/対象 name/時刻を覚える。
  const lastPushRef = useRef<{
    kind: 'nudge' | 'other' | null
    name: string | null
    at: number
  }>({ kind: null, name: null, at: 0 })

  // 削除告知トースト: 削除直後に「元に戻す＝handleUndo」を出すための軽量フラグのみ。
  const [deleteToast, setDeleteToast] = useState(false)
  const deleteToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 現在の編集 state を ref で常に最新参照できるようにする。pushUndo はこの ref から
  // 「適用前 snapshot」を組むので、依存配列を増やさず安定に呼べる。
  // 🚨 代入は hook body トップレベル（useEffect にすると start 時の退避が 1 フレーム古くなる）。
  const fieldsRef = useRef(fields)
  fieldsRef.current = fields
  const newFieldNamesRef = useRef(newFieldNames)
  newFieldNamesRef.current = newFieldNames
  const labelDirtyNamesRef = useRef(labelDirtyNames)
  labelDirtyNamesRef.current = labelDirtyNames

  /** 現在の編集 state を 3 点 1 組のスナップショットへ。Set は配列化。 */
  const currentSnapshot = useCallback(
    (): EditSnapshot => ({
      fields: fieldsRef.current,
      newFieldNames: [...newFieldNamesRef.current],
      labelDirtyNames: [...labelDirtyNamesRef.current],
    }),
    [],
  )

  /**
   * 操作の**適用前**に直前 snapshot を undoStack へ積む。
   *   - kind='nudge' のときは coalesce 判定（同一 selectedName×600ms 以内の連続を1ステップに）。
   *   - 新規操作が来たら redoStack をクリア（標準 undo/redo）。
   */
  const pushUndo = useCallback(
    (kind: 'nudge' | 'other', targetName: string | null) => {
      const now = Date.now()
      const coalesce =
        kind === 'nudge' &&
        shouldCoalesceNudge(lastPushRef.current, {
          name: targetName ?? '',
          now,
        })
      const before = currentSnapshot()
      setUndoStack((stack) => pushSnapshot(stack, before, { coalesce }))
      // coalesce で実際に積まなかった場合でも「最後の操作時刻」は更新（連続押下の窓を延長）。
      lastPushRef.current = { kind, name: targetName, at: now }
      // 新規操作＝redo 系列は破棄（coalesce 中の連続 nudge でも redo は無効化で問題なし）。
      setRedoStack((r) => (r.length === 0 ? r : []))
    },
    [currentSnapshot],
  )

  /** スナップショットを編集 state へ適用＋UI 一時状態リセット（undo/redo 共通）。 */
  const applySnapshot = useCallback(
    (snap: EditSnapshot) => {
      setFields(snap.fields)
      setNewFieldNames(new Set(snap.newFieldNames))
      setLabelDirtyNames(new Set(snap.labelDirtyNames))
      // UI 一時状態は履歴外＝巻き戻し先に選択枠が無い場合の整合のためリセット。
      setSelectedName(null)
      setSelectionGeom(null)
      setLabelEditingName(null)
      setSplitEditing(null)
      // coalesce の連鎖を断つ（undo/redo 直後の nudge は新ステップにする）。
      lastPushRef.current = { kind: null, name: null, at: 0 }
    },
    [setSelectionGeom],
  )

  // undo/redo は ref から最新スタックを読み、副作用（setState）を updater 外で実行する
  // （StrictMode の updater 二重呼び出しでも安全に保つ）。
  const undoStackRef = useRef(undoStack)
  undoStackRef.current = undoStack
  const redoStackRef = useRef(redoStack)
  redoStackRef.current = redoStack

  /** 戻る（undo）: undoStack pop→適用。現在状態を redoStack へ退避。 */
  const handleUndo = useCallback(() => {
    const { snap, rest } = popSnapshot(undoStackRef.current)
    if (!snap) return
    const before = currentSnapshot()
    applySnapshot(snap)
    setUndoStack(rest)
    setRedoStack((r) => pushSnapshot(r, before, { coalesce: false }))
  }, [currentSnapshot, applySnapshot])

  /** 進む（redo）: redoStack pop→適用。現在状態を undoStack へ。 */
  const handleRedo = useCallback(() => {
    const { snap, rest } = popSnapshot(redoStackRef.current)
    if (!snap) return
    const before = currentSnapshot()
    applySnapshot(snap)
    setRedoStack(rest)
    setUndoStack((u) => pushSnapshot(u, before, { coalesce: false }))
  }, [currentSnapshot, applySnapshot])

  // ドラッグの undo は「開始時は退避だけ・確定時に bbox が変化した場合のみ push」
  //   （クリック＝選択のみ（移動量0）で undo を誤有効化しないため）。
  const dragPreSnapshotRef = useRef<EditSnapshot | null>(null)

  /** ドラッグ開始（移動/リサイズ）: ドラッグ前 snapshot を退避（push はしない）。 */
  const handleFieldDragStart = useCallback(
    (_name: string) => {
      dragPreSnapshotRef.current = currentSnapshot()
    },
    [currentSnapshot],
  )

  /** ドラッグ確定: 実際に bbox が変化したときだけ退避 snapshot を push（1ドラッグ=1ステップ）。 */
  const handleFieldDragCommit = useCallback(
    (_name: string, changed: boolean) => {
      const pre = dragPreSnapshotRef.current
      dragPreSnapshotRef.current = null
      if (!changed || !pre) return // クリックのみ（移動量0）は push せず「戻る」を誤有効化しない。
      setUndoStack((stack) => pushSnapshot(stack, pre, { coalesce: false }))
      // 明示的な編集が確定＝直前の nudge coalesce 連鎖を断ち、redo 系列を破棄。
      lastPushRef.current = { kind: 'other', name: _name, at: Date.now() }
      setRedoStack((r) => (r.length === 0 ? r : []))
    },
    [],
  )

  const applyBbox = useCallback(
    (name: string, bbox: BboxPt & { page: number }) => {
      setFields((prev) =>
        prev.map((f) => (f.name === name ? { ...f, bbox } : f)),
      )
    },
    [],
  )

  // nudge / キーボード共通の 1px 操作（pt 空間で直接加減算）。適用前 snapshot を push
  // （連続 nudge は coalesce で1ステップ）。
  const applyNudge = useCallback(
    (action: NudgeAction) => {
      nudgeSelected(setFields, selectedName, pageSizes, action, () =>
        pushUndo('nudge', selectedName),
      )
    },
    [selectedName, pageSizes, pushUndo],
  )

  // 中央寄せ（水平センタリング）。選択 field の x を (pageW − w)/2 に。
  // 適用前 snapshot を push（中央寄せは単発＝1ステップ）。
  const applyCenter = useCallback(() => {
    centerSelected(setFields, selectedName, pageSizes, () =>
      pushUndo('other', selectedName),
    )
  }, [selectedName, pageSizes, pushUndo])

  // 「枠を追加」: 対象ページ（選択枠があればそのページ、無ければ先頭）の中央に定型枠を 1 つ生成→選択。
  // name はクライアント楽観採番 field_N（サーバ確定）。label は空の「項目N」仮置きで持ち、
  // 生成直後にインライン入力欄を出す。
  const handleAddField = useCallback(() => {
    if (pageSizes.length === 0) return
    // 件数ガード: 20 個以上なら追加しない（ボタンも disabled だが防御）。
    if (fields.length >= FIELDS_MAX) return

    // undo: 適用前 snapshot を push（追加は単発＝1ステップ。no-op ガード通過後に積む）。
    pushUndo('other', selectedName)

    const selected = fields.find((f) => f.name === selectedName)
    const targetPage = selected ? selected.bbox.page : pageSizes[0].page
    const meta = pageSizes.find((p) => p.page === targetPage) ?? pageSizes[0]

    const used = new Set(fields.map((f) => f.name))
    const name = nextClientFieldName(used)
    const newField: EditorField = {
      name,
      label: placeholderLabel(fields.length),
      bbox: centeredNewBbox(meta),
    }
    setFields((prev) => [...prev, newField])
    setNewFieldNames((prev) => {
      const next = new Set(prev)
      next.add(name)
      return next
    })
    setSelectedName(name)
    // 生成と同時に label インライン入力を開く。
    setLabelEditingName(name)
  }, [pageSizes, fields, selectedName, pushUndo])

  // 「縦に2分割」: 選択枠を中央で左右2枠に割る。
  //   - 左枠＝元 field（name 維持・bbox 左半分・label はユーザー入力で差替＝labelDirty）。
  //   - 右枠＝新 field（field_N 楽観採番・isNew・bbox 右半分・font は元 field 継承＝サーバ側）。
  // 分割直後に左右2枠の label 入力パネル（splitEditing）を出して 2 枠を命名させる。
  const handleSplitSelected = useCallback(() => {
    if (!selectedName) return
    const target = fields.find((f) => f.name === selectedName)
    if (!target) return
    // 件数ガード: 分割は +1。19 個以上なら 20 を超えるので不可。
    if (fields.length >= FIELDS_MAX) return
    // 最小幅ガード: 半分が最小幅未満なら分割不可。
    if (target.bbox.w / 2 < MIN_BBOX_PT) return

    // undo: 適用前 snapshot を push（分割は左右2枠生成を1ステップ扱い）。
    pushUndo('other', selectedName)

    const [leftBbox, rightBbox] = splitVertical(target.bbox)
    // 右枠の name はクライアント楽観採番（既存 + 自分以外と衝突しない field_N）。
    const used = new Set(fields.map((f) => f.name))
    const rightName = nextClientFieldName(used)
    const origLabel = target.label

    setFields((prev) => {
      const next: EditorField[] = []
      for (const f of prev) {
        if (f.name === selectedName) {
          // 左枠＝元 field（name 維持・bbox 左半分・label は空にしてユーザー入力を促す）。
          next.push({ ...f, label: '', bbox: { ...leftBbox, page: f.bbox.page } })
          // 右枠＝新 field（元 field の直後に挿入・label 空・bbox 右半分）。
          next.push({
            name: rightName,
            label: '',
            bbox: { ...rightBbox, page: f.bbox.page },
          })
        } else {
          next.push(f)
        }
      }
      return next
    })
    // 右枠を新規（INSERT）として登録。左枠は labelDirty（既存・label 差替）として登録。
    setNewFieldNames((prev) => {
      const nextSet = new Set(prev)
      nextSet.add(rightName)
      return nextSet
    })
    setLabelDirtyNames((prev) => {
      const nextSet = new Set(prev)
      nextSet.add(selectedName)
      return nextSet
    })
    // 単一枠 label 入力（追加用）が開いていたら閉じ、2 枠命名パネルへ切替。
    setLabelEditingName(null)
    setSelectedName(null)
    setSelectionGeom(null)
    setSplitEditing({ leftName: selectedName, rightName, origLabel })
  }, [selectedName, fields, pushUndo, setSelectionGeom])

  // 分割 2 枠命名パネルの label 変更（左右どちらか・max40）。
  const handleSplitLabelChange = useCallback((name: string, value: string) => {
    const clipped = value.slice(0, LABEL_MAX)
    setFields((prev) =>
      prev.map((f) => (f.name === name ? { ...f, label: clipped } : f)),
    )
  }, [])

  // 分割 2 枠命名の確定。空のままの枠は「項目N」「項目N+1」を仮置きする。
  const handleSplitCommit = useCallback(() => {
    setSplitEditing((editing) => {
      if (!editing) return null
      setFields((prev) => {
        // 仮置きの基準 N は「この 2 枠を除いた既存項目数」。左→N、右→N+1。
        const others = prev.filter(
          (f) => f.name !== editing.leftName && f.name !== editing.rightName,
        ).length
        return prev.map((f) => {
          if (f.name === editing.leftName && f.label.trim() === '') {
            return { ...f, label: placeholderLabel(others) }
          }
          if (f.name === editing.rightName && f.label.trim() === '') {
            return { ...f, label: placeholderLabel(others + 1) }
          }
          return f
        })
      })
      return null
    })
  }, [])

  // 選択中の既存 field の「項目名を編集」をインラインで開く（鉛筆アイコンから呼ぶ）。
  // labelEditingName を選択枠に向けるだけ（確定は handleLabelCommit）。
  const handleStartRenameLabel = useCallback(() => {
    if (!selectedName) return
    setLabelEditingName(selectedName)
  }, [selectedName])

  // label インライン入力の確定/変更（max40・空は「項目N」仮置き）。
  const handleLabelChange = useCallback((name: string, value: string) => {
    const clipped = value.slice(0, LABEL_MAX)
    setFields((prev) =>
      prev.map((f) => (f.name === name ? { ...f, label: clipped } : f)),
    )
  }, [])

  // label 入力欄を閉じる（確定）。空のままなら「項目N」を仮置きする。
  // 確定対象が既存 field（新規=newFieldNames でない）なら labelDirtyNames へ合流させ、
  // 保存時に {labelDirty:true} で送って既存 label を差替える。新規枠は isNew 経路で label ごと
  // INSERT されるため labelDirty は付けない（排他）。
  const handleLabelCommit = useCallback(() => {
    const target = labelEditingName
    setFields((prev) => {
      let idx = -1
      const next = prev.map((f, i) => {
        if (f.name !== target) return f
        idx = i
        if (f.label.trim() === '') {
          return { ...f, label: placeholderLabel(i) }
        }
        return f
      })
      return idx === -1 ? prev : next
    })
    if (target && !newFieldNames.has(target)) {
      setLabelDirtyNames((prev) => {
        if (prev.has(target)) return prev
        const next = new Set(prev)
        next.add(target)
        return next
      })
    }
    setLabelEditingName(null)
  }, [labelEditingName, newFieldNames])

  // 削除は確認ダイアログを出さず即削除（保存まで DB 不変なので破壊的でない）。最後の1枠は削除不可。
  // 削除も汎用 undoStack に積む。トーストは「元に戻す＝handleUndo」を呼ぶ薄い告知
  // （8秒過ぎても ↩ で戻せる）。
  const clearDeleteToastTimer = useCallback(() => {
    if (deleteToastTimerRef.current) {
      clearTimeout(deleteToastTimerRef.current)
      deleteToastTimerRef.current = null
    }
  }, [])

  const handleDeleteSelected = useCallback(() => {
    if (!selectedName) return
    // 最後の1枠ガード: fields が1個なら削除しない（ボタンも disabled だが防御）。
    if (fields.length <= 1) return
    const target = fields.find((f) => f.name === selectedName)
    if (!target) return
    // undo: 適用前 snapshot を汎用スタックへ push（削除も他操作と同一機構）。
    pushUndo('other', selectedName)
    const wasNew = newFieldNames.has(selectedName)
    setFields((prev) => prev.filter((f) => f.name !== selectedName))
    // 新規枠を削除した場合は new 集合と label 入力からも掃除（保存対象外）。
    if (wasNew) {
      setNewFieldNames((prev) => {
        const next = new Set(prev)
        next.delete(selectedName)
        return next
      })
    }
    // 分割左枠（labelDirty 登録済み）を削除する場合は集合から掃除（label 差替不要に）。
    setLabelDirtyNames((prev) => {
      if (!prev.has(selectedName)) return prev
      const next = new Set(prev)
      next.delete(selectedName)
      return next
    })
    if (labelEditingName === selectedName) setLabelEditingName(null)
    setSelectedName(null)
    // 告知トーストを一定時間表示（undo 可能時間とは切り離す＝消えても undoStack は残る）。
    setDeleteToast(true)
    clearDeleteToastTimer()
    deleteToastTimerRef.current = setTimeout(() => {
      setDeleteToast(false)
      deleteToastTimerRef.current = null
    }, 8000)
  }, [
    selectedName,
    fields,
    newFieldNames,
    labelEditingName,
    clearDeleteToastTimer,
    pushUndo,
  ])

  // トースト「元に戻す」: 汎用 undo を1回呼ぶ薄いラッパ。トーストも閉じる。
  const handleUndoDelete = useCallback(() => {
    handleUndo()
    setDeleteToast(false)
    clearDeleteToastTimer()
  }, [handleUndo, clearDeleteToastTimer])

  useEffect(() => clearDeleteToastTimer, [clearDeleteToastTimer])

  // キーボード: 矢印 = 移動 / Shift+矢印 = リサイズ ＋ Ctrl+Z=undo / Ctrl+Shift+Z=redo。
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Ctrl/⌘+Z=undo, Ctrl/⌘+Shift+Z=redo。選択無しでも有効（履歴は選択非依存）。
      //   ただし input/textarea フォーカス中はブラウザのテキスト undo に任せ bbox undo は非発火。
      const tag = (e.target as HTMLElement)?.tagName
      const inEditable =
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        (e.target as HTMLElement)?.isContentEditable === true
      if (!inEditable && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) handleRedo()
        else handleUndo()
        return
      }
      if (!selectedName) return
      const map: Record<string, { move: NudgeAction; resize: NudgeAction }> = {
        ArrowUp: { move: 'move-up', resize: 'h-minus' },
        ArrowDown: { move: 'move-down', resize: 'h-plus' },
        ArrowLeft: { move: 'move-left', resize: 'w-minus' },
        ArrowRight: { move: 'move-right', resize: 'w-plus' },
      }
      const entry = map[e.key]
      if (!entry) return
      e.preventDefault()
      applyNudge(e.shiftKey ? entry.resize : entry.move)
    },
    [selectedName, applyNudge, handleUndo, handleRedo],
  )

  // 戻り値: 保存成功なら true・失敗なら false（離脱ガードの一括保存で成否判定に使う）。
  const save = useCallback(async (): Promise<boolean> => {
    setSaving(true)
    setBodyErrorMsg(null)
    try {
      // 保存ペイロードを全 field スナップショット形式で送る。
      // - 新規枠（追加 / 分割右枠・newFieldNames に含む）: {name,label,bbox,isNew:true}
      //   ＝サーバが INSERT＋属性デフォルト補完＋name 採番再確定。
      // - 分割左枠（labelDirtyNames に含む）: {name,label,bbox,labelDirty:true}
      //   ＝既存 field の bbox 差替＋label のみ差替。font 等は温存。
      // - その他の既存枠: {name,bbox}（label/isNew/labelDirty 無し＝UPDATE・他属性温存）。
      // 🚨 labelDirty と isNew は排他（新規枠は labelDirty を付けない）。
      // 削除した枠は fields state から除外済みなので配列に含まれず、サーバが DELETE 判定する。
      const cur = fieldsRef.current
      const payload = cur.map((f) => {
        if (newFieldNamesRef.current.has(f.name)) {
          return { name: f.name, label: f.label, bbox: f.bbox, isNew: true }
        }
        if (labelDirtyNamesRef.current.has(f.name)) {
          return { name: f.name, label: f.label, bbox: f.bbox, labelDirty: true }
        }
        return { name: f.name, bbox: f.bbox }
      })
      const result = await updateTemplateFieldsBbox(
        templateId,
        payload,
        getFieldsVersion(),
      )
      // 保存成功: 新スナップショット・新バージョンに更新（連続編集可）。
      // 新規枠は DB に INSERT 済み＝以後は既存枠扱いにする（再保存で重複 INSERT しない）。
      setFieldsVersion(result.fieldsVersion)
      setSnapshot(JSON.stringify(cur))
      setNewFieldNames(new Set())
      // 分割左枠の label 差替も DB 反映済み＝以後は通常 UPDATE 扱い（再送不要）。
      setLabelDirtyNames(new Set())
      // 保存で undo/redo スタックを両クリア（保存後は前の編集に戻せない＝fieldsVersion 楽観ロック整合）。
      setUndoStack([])
      setRedoStack([])
      setDeleteToast(false)
      clearDeleteToastTimer()
      lastPushRef.current = { kind: null, name: null, at: 0 }
      return true
    } catch (e) {
      // 生コードのまま本体へ渡し、表示時に humanizeErrorCode で日本語化する。
      setBodyErrorMsg(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setSaving(false)
    }
  }, [
    templateId,
    clearDeleteToastTimer,
    getFieldsVersion,
    setFieldsVersion,
    setBodyErrorMsg,
  ])

  const dirty = useMemo(
    () => snapshot !== '' && JSON.stringify(fields) !== snapshot,
    [fields, snapshot],
  )

  // 初回ロードでの確定。fields/snapshot に加え、履歴・採番集合・選択・命名 UI も初期状態へ揃える
  // （再入場時に前回の undo 履歴や新規採番フラグが残らないよう全消去）。
  const init = useCallback((initFields: EditorField[], initSnapshot: string) => {
    setFields(initFields)
    setSnapshot(initSnapshot)
    setUndoStack([])
    setRedoStack([])
    setNewFieldNames(new Set())
    setLabelDirtyNames(new Set())
    setSelectedName(null)
    setLabelEditingName(null)
    setSplitEditing(null)
    setDeleteToast(false)
    clearDeleteToastTimer()
    lastPushRef.current = { kind: null, name: null, at: 0 }
  }, [clearDeleteToastTimer])

  return {
    fields,
    selectedName,
    setSelectedName,
    newFieldNames,
    labelEditingName,
    labelDirtyNames,
    splitEditing,
    snapshot,
    saving,
    dirty,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    deleteToast,
    applyBbox,
    applyNudge,
    applyCenter,
    handleAddField,
    handleSplitSelected,
    handleSplitLabelChange,
    handleSplitCommit,
    handleStartRenameLabel,
    handleLabelChange,
    handleLabelCommit,
    handleDeleteSelected,
    handleUndoDelete,
    handleFieldDragStart,
    handleFieldDragCommit,
    handleUndo,
    handleRedo,
    onKeyDown,
    save,
    init,
  }
}
