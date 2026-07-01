'use client'

/**
 * useMinuteAdjustEditor — 議事録 AdjustView の編集状態を一括管理する custom hook。
 *
 * 単一層エディタ（記入欄のみ）の state / ref / useMemo / handler / effect を内包し、
 * AdjustView 本体には「2 hook 呼び出し + JSX + 離脱ガード」だけを残すための抽出。
 *
 * ── 単一スタック方式（MinutesEditSnapshot）──────────────────────────────────
 * 値編集・位置・サイズ・整形・項目削除・項目追加すべてを 1 つの MinutesEditSnapshot
 * （values + overrides + fields + newFieldNames の 4 点組）として undo/redo する。
 * 層別 hook へ分割できない（values と overrides が AdjustView 固有の 2 軸として絡む）。
 *
 * ── coalesce（lastPushRef）同居必須 ─────────────────────────────────────────
 * undo の coalesce は 1 つの lastPushRef で 'nudge'（600ms）/ 'value'（1秒）/ 'other' の
 * 3 種を捌く。lastPushRef を書き換える pushUndo / applySnapshot / handleDragCommit は
 * 必ずこの hook 内に同居させる（バラすと coalesce 連鎖が破綻する）。
 *
 * ── A∩B=∅ 不変条件（二重描画退行対策）─────────────────────────────────
 * isDragging（state）/ hasAnyOverride（useMemo）/ dynamicFieldValues（useMemo）の 3 要素は
 * この hook に同居する。これらは「ドラッグ層凍結 + selectedOnlyBgUrl 経路」の不変条件
 * A∩B=∅ を構造保証する。以下を絶対に守る:
 *   - isDragging を ref に変えない（setIsDragging は handleDragStart / handleDragCommit の 2 箇所のみ）。
 *   - hasAnyOverride useMemo の deps は [fields, overrides] 厳守。
 *   - dynamicFieldValues は必ず shouldComposeFieldClientSide 純関数を呼ぶ（判定式を hook 内に
 *     書き直さない）。hasOverride 分岐（撤回済み）を絶対に復活させない。
 *   - useDebouncedSelectedBackground への selected 引数は本体で `hasAnyOverride ? null : selected`
 *     を必ず守る（本 hook は isDragging / hasAnyOverride / selected を返すだけ）。
 *
 * ── dragPreSnapshotRef 取りこぼし防止 ───────────────────────────────────────
 * dragPreSnapshotRef + handleDragStart + handleDragCommit + currentSnapshot + ref ミラー
 * 4 種 + latestBboxRef + rafIdRef + flushBboxChanges + handleChangeBbox + RAF unmount
 * cleanup effect は必ずこの hook 内に同居する。ref ミラー代入（fieldsRef.current = fields）は
 * hook body トップレベルで行う（useEffect 化すると 1 フレーム遅れる）。
 *
 * handleDragCommit の 6 ステップ順序を固定する（分割の都合で動かさない）:
 *   ① rafIdRef cancel（cancelAnimationFrame）
 *   ② latestBboxRef.size > 0 なら flushBboxChanges() で同期 flush
 *   ③ setIsDragging(false)      ← ②の後！ flush 前に false にすると selectedOnlyBgUrl 経路に
 *                                  切替わり描画ズレが起きる
 *   ④ dragPreSnapshotRef.current を pre に取り出して null クリア
 *   ⑤ !changed || !pre なら return（クリックのみ→積まない）
 *   ⑥ setUndoStack push + lastPushRef 更新 + setRedoStack クリア
 *
 * ── dirty の hot path 化防止 ─────────────────────────────────────────────────
 * editorDirty は hook 内 useMemo（deps: [values, overrides, fields, newFieldNames]）。
 * title / meetingDate は本体維持なので、本体で `editor.dirty || metaDirty` の boolean OR を組む。
 * snapshotsEqual / cloneSnapshot は純関数のまま（毎レンダー呼び出しにしない）。
 *
 * ── bbox.h マウント初期化（旧議事録マイグレーション）────────────────────────
 * previewFont ロード完了かつ pdfFields 取得後に一度だけ overrides.h を初期化する。
 * 既存 overrides.h と overrides.y が両方ある場合のみ skip（手動調整尊重）。
 * 「h あり y なし」は旧議事録マイグレーション経路として中央維持 y を再計算する。
 * h は max(テンプレ h, requiredH) で縮小禁止。y シフトは computeBboxCenteredYShift で拡張時のみ。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type FieldOverride,
  type BboxOverrides,
  applyBboxOverrides,
} from '@/lib/pdf-output/field-override'
import { RANGE_MAX, RANGE_MIN, computeUniformFontSize } from '@/lib/pdf-output/uniform-size'
import {
  clampUniformOverridePt,
  isOutOfRange,
  readUniformOverridePt,
  writeUniformOverridePt,
} from '@/lib/pdf-output/uniform-override'
import type { FittableFont } from '@/lib/pdf-output/fitting'
import { computeRequiredBboxHeight } from '@/lib/parsers/pdf/required-bbox-height'
import {
  centerHorizontally,
  centeredNewBbox,
  type PageMeta,
} from '@/lib/pdf-output/bbox-coords'
import type { EditorField } from '@/app/(dashboard)/templates/[id]/bbox-pane'
import type { NudgeAction } from '@/app/(dashboard)/templates/[id]/nudge-controls'
import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'
import {
  buildPdfFieldFromDefaults,
  nextClientFieldName,
  placeholderLabel,
} from '@/lib/pdf-output/bbox-save'
import type { FieldValueComposite } from '@/lib/preview/field-values-composite-canvas'
import { useDebouncedSelectedBackground } from '@/lib/utils/use-debounced-selected-background'
import {
  type TemplateFieldDef,
  applyBboxFlushUpdates,
  computeBboxCenteredYShift,
  shouldComposeFieldClientSide,
} from '@/app/(dashboard)/minutes/[id]/adjust/AdjustView'

const FONT_SIZE_MIN = 8 // 既存 PdfField.font_size_min と一致（読めるギリギリ）
const FONT_SIZE_MAX = RANGE_MAX // 上限 18pt

/** fields 配列の上限。20 で「項目を追加」disabled。 */
const FIELDS_MAX = 20
/** label 最大文字数。 */
const LABEL_MAX = 40

// nudge coalesce 窓（600ms・undo-stack.NUDGE_COALESCE_MS と一致）。
const NUDGE_COALESCE_MS = 600
// 値編集 coalesce 窓（1 秒・templates 移植元 lastFixedValueEditRef と一致）。
const VALUE_COALESCE_MS = 1000

/**
 * 単一スタック方式の MinutesEditSnapshot。
 * 値 + overrides を 1 ステップに持ち、値編集・位置・サイズ・整形・項目削除すべてを undo 対象に。
 * newFieldNames を snapshot に含めることで「項目追加 → 値入力 → undo」「項目追加 → 削除 → undo」
 * で newFieldNames も復元する（drift 解消）。
 */
export type MinutesEditSnapshot = {
  values: Record<string, string>
  overrides: BboxOverrides
  fields: TemplateFieldDef[]
  newFieldNames: Set<string>
}

function cloneSnapshot(s: MinutesEditSnapshot): MinutesEditSnapshot {
  return {
    values: { ...s.values },
    overrides: Object.fromEntries(
      Object.entries(s.overrides).map(([k, v]) => [k, { ...v }]),
    ),
    fields: s.fields.map((f) => ({ ...f, bbox: { ...f.bbox } })),
    newFieldNames: new Set(s.newFieldNames),
  }
}

function snapshotsEqual(
  a: MinutesEditSnapshot,
  b: MinutesEditSnapshot,
): boolean {
  // values
  const aKeys = Object.keys(a.values)
  const bKeys = Object.keys(b.values)
  if (aKeys.length !== bKeys.length) return false
  for (const k of aKeys) if (a.values[k] !== b.values[k]) return false
  // overrides
  const aoKeys = Object.keys(a.overrides)
  const boKeys = Object.keys(b.overrides)
  if (aoKeys.length !== boKeys.length) return false
  for (const k of aoKeys) {
    const av = a.overrides[k]
    const bv = b.overrides[k]
    if (!bv) return false
    if (
      av.x !== bv.x ||
      av.y !== bv.y ||
      av.w !== bv.w ||
      av.h !== bv.h ||
      av.fontSize !== bv.fontSize
    )
      return false
  }
  // fields（name 集合の差分判定で必要十分・bbox は overrides 経由で評価）
  if (a.fields.length !== b.fields.length) return false
  for (let i = 0; i < a.fields.length; i++) {
    if (a.fields[i].name !== b.fields[i].name) return false
  }
  // newFieldNames 集合差分（追加 → 削除 → undo の drift 検知）。
  if (a.newFieldNames.size !== b.newFieldNames.size) return false
  for (const n of a.newFieldNames) if (!b.newFieldNames.has(n)) return false
  return true
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/**
 * TemplateFieldDef[] を BboxPane が必要とする EditorField[] に変換（pt 空間維持）。
 * AdjustView は 1 ページ前提。
 */
function toEditorFields(
  fields: TemplateFieldDef[],
  overrides: BboxOverrides,
  pageNumber: number,
): EditorField[] {
  return fields.map((f) => {
    const o = overrides[f.name]
    return {
      name: f.name,
      label: f.label,
      bbox: {
        x: o?.x ?? f.bbox.x,
        y: o?.y ?? f.bbox.y,
        w: o?.w ?? f.bbox.w,
        h: o?.h ?? f.bbox.h,
        page: pageNumber,
      },
    }
  })
}

/**
 * name で実 PdfField を引いて bbox.page だけ揃えた派生を返す。実テンプレの
 * padding / font.size / multiline / font_size_min をそのまま保つことで、canvas 経路の
 * wrap maxW（= bbox.w - padding.left - padding.right）が PDF 経路（overlay-generator →
 * fitting.ts）と完全一致する。実 PdfField が無い name は null を返し、呼出側でスキップ。
 */
function lookupPdfField(
  pdfFields: PdfField[],
  name: string,
  pageNumber: number,
): PdfField | null {
  const found = pdfFields.find((p) => p.name === name)
  if (!found) return null
  if (found.bbox.page === pageNumber) return found
  return { ...found, bbox: { ...found.bbox, page: pageNumber } }
}

/**
 * 新規追加 field（newFieldNames）の PdfField を runtime で合成する。pdfFields は initial 不変
 * （props 由来）のため、追加直後の新規 field を lookupPdfField で引くと null になる。
 * buildPdfFieldFromDefaults で属性補完して canvas 動的プレビューに乗せる。
 */
function synthesizePdfFieldFromTemplateDef(
  f: TemplateFieldDef,
  pageNumber: number,
): PdfField {
  return buildPdfFieldFromDefaults({
    name: f.name,
    label: f.label,
    bbox: { page: pageNumber, x: f.bbox.x, y: f.bbox.y, w: f.bbox.w, h: f.bbox.h },
    multiline: f.multiline ?? false,
  })
}

/**
 * lookupPdfField が null（新規追加 field のため pdfFields に無い）の場合に、
 * TemplateFieldDef から runtime PdfField を生成して返す。既存 field（lookup ヒット）は
 * ヒット側を優先する（本関数は新規 field のみ対象）。
 */
function resolveEffectivePdfField(
  pdfFields: PdfField[],
  field: TemplateFieldDef,
  pageNumber: number,
): PdfField {
  const found = lookupPdfField(pdfFields, field.name, pageNumber)
  if (found) return found
  return synthesizePdfFieldFromTemplateDef(field, pageNumber)
}

export interface UseMinuteAdjustEditorParams {
  minuteId: string
  initialFields: TemplateFieldDef[]
  initialValues: Record<string, string>
  initialOverrides: BboxOverrides
  pdfFields: PdfField[]
  fixedTextSizesPt?: number[]
  /** 本体が取得して渡す（pageSizes effect は本体維持）。 */
  pageSizes: PageMeta[]
  /** 本体が遅延ロードして渡す。 */
  previewFont: FittableFont | null
  /** bbox 直接クリック後の autoFocus 用。BboxPane と Inspector の両方が触るため本体管理。 */
  textareaRef: React.RefObject<HTMLTextAreaElement | HTMLInputElement | null>
  /**
   * true のとき useDebouncedSelectedBackground を無効化する（既定 false）。
   * guest-render は selected 切替に関わらず同じ背景を返すため、selected-only 最適化が
   * 意味を持たない（無駄な fetch を発生させないための明示的な off スイッチ）。
   */
  guestMode?: boolean
}

export interface UseMinuteAdjustEditor {
  // エディタ状態
  fields: TemplateFieldDef[]
  values: Record<string, string>
  overrides: BboxOverrides
  selected: string | null
  setSelected: (name: string | null) => void
  newFieldNames: Set<string>
  labelEditingName: string | null
  isDragging: boolean
  // 派生値（useMemo 内包）
  editorFields: EditorField[]
  hasAnyOverride: boolean
  /**
   * selected 以外を焼き込み済みの背景 PNG signedUrl（debounce 取得）。
   * 本体は resolveWhiteoutRawImageUrl(isDragging, rawBgUrl, selectedOnlyBgUrl) で BboxPane に渡す。
   * hasAnyOverride 時は内部で selected=null を渡して null になる（A∩B=∅ 構造保証）。
   */
  selectedOnlyBgUrl: string | null
  uniformOverridePt: number | null
  fieldValuesUniformFontSize: number | undefined
  dynamicFieldValues: FieldValueComposite[]
  dirty: boolean
  canUndo: boolean
  canRedo: boolean
  uniformOverrideNotice: string | null
  // 履歴
  undo: () => void
  redo: () => void
  // 値編集
  onValueChange: (name: string, v: string) => void
  setValues: React.Dispatch<React.SetStateAction<Record<string, string>>>
  // 位置 / サイズ
  applyNudgeAction: (action: NudgeAction) => void
  applyCenterHorizontal: () => void
  onFontSizeStep: (delta: number) => void
  onFontSizeReset: () => void
  // 全体 uniform
  onUniformOverrideChange: (pt: number | null) => void
  onUniformOverrideStep: (delta: number) => void
  onUniformOverrideReset: () => void
  // 項目操作
  handleAddField: () => void
  handleLabelChange: (name: string, value: string) => void
  handleLabelCommit: () => void
  handleDeleteSelected: () => void
  // BboxPane へ渡す drag 配線（RAF 間引き + dragPreSnapshot 内包）
  handleChangeBbox: (
    name: string,
    bbox: { x: number; y: number; w: number; h: number; page: number },
  ) => void
  handleDragStart: () => void
  handleDragCommit: (name: string, changed: boolean) => void
  // 保存ペイロード（DB 呼び出しは本体）
  buildSavePayload: () => {
    content: Record<string, string>
    overrides: BboxOverrides
    newFields?: PdfField[]
  }
  // pushUndo を整形 SSE（本体維持）から打ち込むための薄い穴。
  pushUndoOther: (name: string | null) => void
}

export function useMinuteAdjustEditor(
  params: UseMinuteAdjustEditorParams,
): UseMinuteAdjustEditor {
  const {
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
  } = params

  // ── state（項目削除のため fields も state 化）─────────────────────────────
  const [fields, setFields] = useState<TemplateFieldDef[]>(initialFields)
  const [values, setValues] = useState<Record<string, string>>(initialValues)
  const [overrides, setOverrides] = useState<BboxOverrides>(initialOverrides)
  const [selected, setSelected] = useState<string | null>(null)
  // ドラッグ中 true。selected 切替で whiteoutRawImageUrl が差し替わると bbox-pane.tsx の
  // rawImg ロード useEffect が再走し「2 つ目以降の bbox を選んで動かすとブランク」になる。
  // drag 中のみ案 D を OFF（whiteoutRawImageUrl を rawBgUrl 固定）にするため state 化が必須
  // （ref では whiteoutRawImageUrl 派生再評価が走らない）。
  const [isDragging, setIsDragging] = useState(false)
  // 「項目を追加」UI 用。newFieldNames = 追加 field 名集合（保存時 newFields payload + 削除整合）。
  // labelEditingName = 追加直後に label インライン編集対象。
  const [newFieldNames, setNewFieldNames] = useState<Set<string>>(new Set())
  const [labelEditingName, setLabelEditingName] = useState<string | null>(null)
  const newFieldNamesRef = useRef(newFieldNames)
  newFieldNamesRef.current = newFieldNames

  // 初期 snapshot（dirty 判定の基準・mount 時固定）。newFieldNames も含める（初期は空 Set）。
  const initialSnapshot = useRef<MinutesEditSnapshot>({
    values: { ...initialValues },
    overrides: { ...initialOverrides },
    fields: initialFields.map((f) => ({ ...f, bbox: { ...f.bbox } })),
    newFieldNames: new Set(),
  })

  // ── undo/redo（単一スタック・fields も snapshot に含める）────────────────
  const [undoStack, setUndoStack] = useState<MinutesEditSnapshot[]>([])
  const [redoStack, setRedoStack] = useState<MinutesEditSnapshot[]>([])
  const lastPushRef = useRef<{
    kind: 'nudge' | 'value' | 'other' | null
    name: string | null
    at: number
  }>({ kind: null, name: null, at: 0 })

  const fieldsRef = useRef(fields)
  fieldsRef.current = fields
  const valuesRef = useRef(values)
  valuesRef.current = values
  const overridesRef = useRef(overrides)
  overridesRef.current = overrides
  const undoStackRef = useRef(undoStack)
  undoStackRef.current = undoStack
  const redoStackRef = useRef(redoStack)
  redoStackRef.current = redoStack
  // bbox.h 自動連動 4 経路で useCallback クロージャから最新 previewFont を参照するため ref 化。
  // state を deps に含めると useCallback identity が previewFont ロード後に揺れ、Inspector が
  // 全 commit される（ref で identity 安定）。
  const previewFontRef = useRef<FittableFont | null>(null)
  previewFontRef.current = previewFont

  const currentSnapshot = useCallback(
    (): MinutesEditSnapshot => ({
      values: valuesRef.current,
      overrides: overridesRef.current,
      fields: fieldsRef.current,
      newFieldNames: newFieldNamesRef.current,
    }),
    [],
  )

  /**
   * 適用前 snapshot を undoStack へ push（nudge と value は coalesce 判定あり）。
   * - kind='nudge': 同一 name × 600ms 以内の連続は 1 ステップ。
   * - kind='value': 同一 name × 1 秒以内の連続は 1 ステップ。
   * - 新規操作で redoStack をクリア。
   */
  const pushUndo = useCallback(
    (kind: 'nudge' | 'value' | 'other', targetName: string | null) => {
      const now = Date.now()
      const last = lastPushRef.current
      const windowMs =
        kind === 'nudge'
          ? NUDGE_COALESCE_MS
          : kind === 'value'
            ? VALUE_COALESCE_MS
            : 0
      const coalesce =
        kind !== 'other' &&
        last.kind === kind &&
        last.name === targetName &&
        now - last.at < windowMs
      const before = cloneSnapshot(currentSnapshot())
      if (!coalesce) {
        setUndoStack((stack) => {
          const next = [...stack, before]
          return next.length > 50 ? next.slice(next.length - 50) : next
        })
      }
      lastPushRef.current = { kind, name: targetName, at: now }
      setRedoStack((r) => (r.length === 0 ? r : []))
    },
    [currentSnapshot],
  )

  const applySnapshot = useCallback((snap: MinutesEditSnapshot) => {
    setFields(snap.fields)
    setValues(snap.values)
    setOverrides(snap.overrides)
    setNewFieldNames(new Set(snap.newFieldNames))
    lastPushRef.current = { kind: null, name: null, at: 0 }
  }, [])

  const handleUndo = useCallback(() => {
    const top = undoStackRef.current[undoStackRef.current.length - 1]
    if (!top) return
    const before = cloneSnapshot(currentSnapshot())
    applySnapshot(top)
    setUndoStack((s) => s.slice(0, -1))
    setRedoStack((r) => [...r, before])
  }, [currentSnapshot, applySnapshot])

  const handleRedo = useCallback(() => {
    const top = redoStackRef.current[redoStackRef.current.length - 1]
    if (!top) return
    const before = cloneSnapshot(currentSnapshot())
    applySnapshot(top)
    setRedoStack((r) => r.slice(0, -1))
    setUndoStack((s) => [...s, before])
  }, [currentSnapshot, applySnapshot])

  // 現ページ field のうち overrides に 1 件でもエントリがあるか。
  // true のとき本体は useDebouncedSelectedBackground に渡す selected を null にして
  // selectedOnlyBgUrl を生成させない → useSelectedOnly=false → 全 field を client 合成
  // （B=全field）・背景=rawBgUrl(テキスト0・A=空集合）→ A∩B=∅。
  // deps は [fields, overrides] 厳守。
  const hasAnyOverride = useMemo(
    () => fields.some((f) => overrides[f.name] !== undefined),
    [fields, overrides],
  )

  // selected 切替時に「selected 以外焼き込み済」PNG を debounce 付きで fetch。
  // hasAnyOverride 時は selected=null を渡し selectedOnlyBgUrl を生成させない（null のまま）
  // → useSelectedOnly=false → 全 field を client 合成・背景=rawBgUrl(テキスト0) → A∩B=∅。
  // override 皆無時のみ selectedOnlyBgUrl が生成され案 D（selected のみ client）が効く。
  const selectedOnlyBgUrl = useDebouncedSelectedBackground({
    minuteId,
    selected: hasAnyOverride ? null : selected,
    debounceMs: 300,
    enabled: !guestMode,
  })

  // ── BboxPane に渡す EditorField[]（page 番号は pageSizes 先頭・1 ページ前提）──
  const pageNumber = pageSizes[0]?.page ?? 1
  const editorFields = useMemo(
    () => toEditorFields(fields, overrides, pageNumber),
    [fields, overrides, pageNumber],
  )

  // PDF 出力経路と同じ uniform フォントサイズを算出してプレビューに注入する。
  // bbox_overrides の予約キー __uniform__ から手動上書き値を取り出し、非 null なら snap を
  // スキップして RANGE クランプのみ適用する（手動 > 自動整合 > 素 uniform）。
  const uniformOverridePt = useMemo<number | null>(
    () => readUniformOverridePt(overrides),
    [overrides],
  )

  const fieldValuesUniformFontSize = useMemo<number | undefined>(() => {
    // 手動上書き優先。snap をスキップして RANGE クランプのみ。
    if (uniformOverridePt !== null) {
      return clampUniformOverridePt(uniformOverridePt)
    }
    if (!previewFont || fields.length === 0) return undefined
    // 表示中 fields の name 集合に対応する実 PdfField を取り出す（pdfFields は initial 不変、
    // fields は項目削除で減るため name で intersection を取る）。新規追加 field（pdfFields に
    // 無い name）も runtime 合成で含める → 追加直後でも既存 field と同 uniform で揃う。
    const pdfByName = new Map(pdfFields.map((p) => [p.name, p]))
    const visiblePdfFields: PdfField[] = []
    for (const f of fields) {
      const tpl = pdfByName.get(f.name)
      if (tpl) {
        visiblePdfFields.push(
          tpl.bbox.page === pageNumber
            ? tpl
            : { ...tpl, bbox: { ...tpl.bbox, page: pageNumber } },
        )
      } else {
        visiblePdfFields.push(synthesizePdfFieldFromTemplateDef(f, pageNumber))
      }
    }
    if (visiblePdfFields.length === 0) return undefined
    // uniform 算出時は overrides.h を除外する。マウント effect が overrides.h を書き込む
    // → 本 useMemo の overrides 依存で再評価 → applyBboxOverrides 後の h ベースで uniform 値変化
    // → 議事内容を新 uniform で wrap → 行数 / bbox.h 不整合 → canvas 切れ、の無限ループを断つ。
    // h プロパティだけ抜くことで uniform は素テンプレ bbox.h ベース固定（fontSize/x/y は反映）。
    const overridesForUniform: BboxOverrides = {}
    for (const [name, ov] of Object.entries(overrides)) {
      if (!ov) continue
      const { h: _h, ...rest } = ov
      overridesForUniform[name] = rest
    }
    const effective = applyBboxOverrides(visiblePdfFields, overridesForUniform)
    // 固定テキストサイズ群を渡す。PDF/画像経路と同一の snap が canvas プレビューにも効き、
    // 3 経路の uniform が完全一致する（未指定なら snap 無効＝後方互換）。
    return computeUniformFontSize(
      effective,
      previewFont,
      undefined,
      undefined,
      fixedTextSizesPt,
    )
  }, [previewFont, fields, pdfFields, overrides, pageNumber, fixedTextSizesPt, uniformOverridePt])

  // bbox.h 自動連動: useCallback クロージャから最新 uniform を参照するため ref 化。
  const uniformFontSizeRef = useRef<number | undefined>(undefined)
  uniformFontSizeRef.current = fieldValuesUniformFontSize

  // 動的合成入力（記入欄値）。空 value は除外（焼き込み相当の見た目=なし）。
  // field は実 PdfField から lookup する（実 padding で wrap maxW を PDF と一致させる）。
  //
  // 縮退判定は shouldComposeFieldClientSide 純関数に集約する。判定ロジックをここに書き直さない。
  // hasOverride 分岐（撤回済み）を絶対に復活させない。override 残留時の二重描画は呼出側で
  // hasAnyOverride 時に selected を null にして selectedOnlyBgUrl を生成させないことで A∩B=∅ を
  // 構造保証する。
  // ドラッグ中（isDragging=true）は shouldComposeFieldClientSide が useSelectedOnly を必ず false
  // にして全 field を override 付きで返す。これは案2 captureDragSnapshot が
  // dynamicFieldValues を filter(name!==movingName) でベース PNG に焼き込むため、selectedOnly に
  // 縮退すると「前に動かした field」がスナップに焼かれず元位置に取り残されるのを防ぐ。
  const dynamicFieldValues = useMemo<FieldValueComposite[]>(() => {
    const out: FieldValueComposite[] = []
    for (const f of fields) {
      if (
        !shouldComposeFieldClientSide({
          fieldName: f.name,
          selected,
          selectedOnlyBgUrl,
          isDragging,
        })
      )
        continue
      const v = values[f.name] ?? ''
      if (v.trim() === '') continue
      const pdfField = resolveEffectivePdfField(pdfFields, f, pageNumber)
      const item: FieldValueComposite = {
        field: pdfField,
        value: v,
      }
      const ov = overrides[f.name]
      if (ov) item.override = ov
      out.push(item)
    }
    return out
  }, [fields, pdfFields, values, overrides, pageNumber, selected, selectedOnlyBgUrl, isDragging])

  // ── BboxPane onChangeBbox: 位置 drag / リサイズ確定で呼ばれる ────────────
  // pointermove は 60+ fps で発火する。毎フレーム setOverrides を直に呼ぶと
  // fieldValuesUniformFontSize / dynamicFieldValues useMemo の重い再計算（opentype.js wrap +
  // canvas drawImage）が 60+ fps で走り CPU 占有でフレーム破綻する。
  // pointermove ごとに latestBboxRef に最新値を Map 上書きするだけにし、requestAnimationFrame で
  // 次フレーム頭に 1 回だけ flushBboxChanges → setOverrides。pointerup（handleDragCommit）で
  // 残バッファを同期 flush + RAF cancel。BboxPane / bbox-pane.tsx は不変。
  const latestBboxRef = useRef<
    Map<string, { x: number; y: number; w: number; h: number; page: number }>
  >(new Map())
  const rafIdRef = useRef<number | null>(null)

  const flushBboxChanges = useCallback(() => {
    rafIdRef.current = null
    if (latestBboxRef.current.size === 0) return
    const updates = new Map(latestBboxRef.current)
    latestBboxRef.current.clear()
    setOverrides((prev) =>
      applyBboxFlushUpdates(prev, updates, fieldsRef.current),
    )
  }, [])

  const handleChangeBbox = useCallback(
    (
      name: string,
      bbox: { x: number; y: number; w: number; h: number; page: number },
    ) => {
      latestBboxRef.current.set(name, bbox)
      if (rafIdRef.current === null) {
        rafIdRef.current = requestAnimationFrame(flushBboxChanges)
      }
    },
    [flushBboxChanges],
  )

  // unmount で RAF cancel（リーク防止）。hook unmount で rafIdRef がリークすると次回マウントで
  // 前回 RAF が誤発火するため hook 内に同居させる。
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
    }
  }, [])

  // ドラッグ前 snapshot 退避（位置 drag・リサイズ共通）。
  const dragPreSnapshotRef = useRef<MinutesEditSnapshot | null>(null)
  const handleDragStart = useCallback(() => {
    dragPreSnapshotRef.current = cloneSnapshot(currentSnapshot())
    // drag 開始で案 D OFF（whiteoutRawImageUrl を rawBgUrl 固定に切替）。
    // selected 切替が起きても rawImg ロード useEffect が再走しない → ブランクアウトしない。
    setIsDragging(true)
  }, [currentSnapshot])

  /**
   * ドラッグ確定。6 ステップ順序を固定する（分割の都合で動かさない）:
   *   ① rafIdRef cancel
   *   ② latestBboxRef.size > 0 なら flushBboxChanges() で同期 flush
   *   ③ setIsDragging(false)      ← ②の後！ flush 前に false にすると selectedOnlyBgUrl 経路に
   *                                  切替わり描画ズレ
   *   ④ dragPreSnapshotRef.current を pre に取り出して null クリア
   *   ⑤ !changed || !pre なら return（クリックのみ→積まない）
   *   ⑥ setUndoStack push + lastPushRef 更新 + setRedoStack クリア
   */
  const handleDragCommit = useCallback(
    (name: string, changed: boolean) => {
      // ① ② pointerup で残バッファを同期 flush + RAF cancel。
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
      if (latestBboxRef.current.size > 0) {
        flushBboxChanges()
      }
      // ③ drag 終了で案 D 復帰（selectedOnlyBgUrl ?? rawBgUrl）。
      setIsDragging(false)
      // ④
      const pre = dragPreSnapshotRef.current
      dragPreSnapshotRef.current = null
      // ⑤ クリックのみ＝積まない
      if (!changed || !pre) return
      // ⑥
      setUndoStack((stack) => {
        const next = [...stack, pre]
        return next.length > 50 ? next.slice(next.length - 50) : next
      })
      lastPushRef.current = { kind: 'other', name, at: Date.now() }
      setRedoStack((r) => (r.length === 0 ? r : []))
    },
    [flushBboxChanges],
  )

  // NudgeControls の位置 4 アクション（move-*）のみに対応。
  // bbox 寸法調整はリサイズハンドル（四隅ドラッグ）に一本化し、ボタン UI は持たない。
  // w-* / h-* アクションが万が一発火しても安全な防御のため switch で no-op で受ける。
  // 矢印キーは move-up/down/left/right を呼ぶ。連続操作は 600ms coalesce。
  const applyNudgeAction = useCallback(
    (action: NudgeAction) => {
      if (!selected) return
      const f = fieldsRef.current.find((x) => x.name === selected)
      if (!f) return
      const meta = pageSizes.find((p) => p.page === pageNumber)
      if (!meta) return
      let dx = 0
      let dy = 0
      switch (action) {
        case 'move-up':
          dy = -1
          break
        case 'move-down':
          dy = 1
          break
        case 'move-left':
          dx = -1
          break
        case 'move-right':
          dx = 1
          break
        default:
          return
      }
      pushUndo('nudge', selected)
      const cur = overridesRef.current[selected] ?? {}
      const baseX = cur.x ?? f.bbox.x
      const baseY = cur.y ?? f.bbox.y
      const w = cur.w ?? f.bbox.w
      const h = cur.h ?? f.bbox.h
      const nextX = clamp(baseX + dx, 0, meta.widthPt - w)
      const nextY = clamp(baseY + dy, 0, meta.heightPt - h)
      setOverrides((prev) => ({
        ...prev,
        [selected]: { ...(prev[selected] ?? {}), x: nextX, y: nextY },
      }))
    },
    [selected, pageSizes, pageNumber, pushUndo],
  )

  // 中央寄せ（水平センタリング）。bbox_overrides 経由で x を書き換える。
  const applyCenterHorizontal = useCallback(() => {
    if (!selected) return
    const f = fieldsRef.current.find((x) => x.name === selected)
    if (!f) return
    const meta = pageSizes.find((p) => p.page === pageNumber)
    if (!meta) return
    pushUndo('other', selected)
    const cur = overridesRef.current[selected] ?? {}
    const w = cur.w ?? f.bbox.w
    const y = cur.y ?? f.bbox.y
    const h = cur.h ?? f.bbox.h
    const centered = centerHorizontally({ x: 0, y, w, h }, meta.widthPt)
    setOverrides((prev) => ({
      ...prev,
      [selected]: { ...(prev[selected] ?? {}), x: centered.x },
    }))
  }, [selected, pageSizes, pageNumber, pushUndo])

  // ある field の effective fontSize（pt）を解決する。優先順は applyFieldOverride /
  // compositeFieldValuesOnCanvas と一致: override.fontSize ?? uniform ?? field.font.size。
  const resolveEffectiveFontSize = useCallback(
    (name: string, overrideFontSize: number | undefined): number => {
      const pdfField = pdfFields.find((p) => p.name === name)
      // 新規追加 field（pdfFields に無い）は buildPdfFieldFromDefaults の既定 = 10.5 に揃える。
      const tmplSize = pdfField?.font.size ?? 10.5
      return overrideFontSize ?? uniformFontSizeRef.current ?? tmplSize
    },
    [pdfFields],
  )

  // 値入力（textarea controlled、coalesce 1 秒窓）。value 変更で wrap 行数が変わるため bbox.h も
  // 同フレームで再計算（fontSize は据置）。previewFont 未ロード時は h 更新をスキップ。
  const onValueChange = useCallback(
    (name: string, v: string) => {
      pushUndo('value', name)
      setValues((prev) => ({ ...prev, [name]: v }))
      const font = previewFontRef.current
      if (!font) return
      const tmpl = fieldsRef.current.find((f) => f.name === name)
      if (!tmpl) return
      const pdfField =
        pdfFields.find((p) => p.name === name) ??
        synthesizePdfFieldFromTemplateDef(tmpl, pageNumber)
      setOverrides((prev) => {
        const cur = prev[name] ?? {}
        const effSize = resolveEffectiveFontSize(name, cur.fontSize)
        const requiredH = computeRequiredBboxHeight(pdfField, v, effSize, font)
        // h は max(テンプレ h, requiredH)（縮小禁止）。y は触らない（手動移動位置を尊重）。
        const baseH = pdfField.bbox.h
        const finalH = Math.max(baseH, requiredH)
        return { ...prev, [name]: { ...cur, h: finalH } }
      })
    },
    [pushUndo, pdfFields, pageNumber, resolveEffectiveFontSize],
  )

  // 文字サイズ ± ボタン（per-field fontSize override・bbox 寸法とは別軸）。
  // fontSize 変更時に bbox.h も新 fontSize ベースで同フレーム再計算（拡大・縮小どちらでも連動）。
  const onFontSizeStep = useCallback(
    (delta: number) => {
      if (!selected) return
      pushUndo('other', selected)
      const font = previewFontRef.current
      const tmpl = fieldsRef.current.find((f) => f.name === selected)
      const pdfField = tmpl
        ? pdfFields.find((p) => p.name === selected) ??
          synthesizePdfFieldFromTemplateDef(tmpl, pageNumber)
        : undefined
      const currentValue = valuesRef.current[selected] ?? ''
      setOverrides((prev) => {
        const cur = prev[selected]
        const curSize = cur?.fontSize ?? 12
        const next = clamp(curSize + delta, FONT_SIZE_MIN, FONT_SIZE_MAX)
        const merged: FieldOverride = { ...(cur ?? {}), fontSize: next }
        if (font && pdfField) {
          const requiredH = computeRequiredBboxHeight(
            pdfField,
            currentValue,
            next,
            font,
          )
          // h は max(テンプレ h, requiredH)（縮小禁止）。y は触らない。
          const baseH = pdfField.bbox.h
          merged.h = Math.max(baseH, requiredH)
        }
        return { ...prev, [selected]: merged }
      })
    },
    [selected, pushUndo, pdfFields, pageNumber],
  )

  // 「自動サイズに戻す」: fontSize override のみ削除（位置 override は残す）。
  // 解除後の effective = uniform で h も再計算 → overrides.h を新値に更新。
  const onFontSizeReset = useCallback(() => {
    if (!selected) return
    pushUndo('other', selected)
    const font = previewFontRef.current
    const tmpl = fieldsRef.current.find((f) => f.name === selected)
    const pdfField = tmpl
      ? pdfFields.find((p) => p.name === selected) ??
        synthesizePdfFieldFromTemplateDef(tmpl, pageNumber)
      : undefined
    const currentValue = valuesRef.current[selected] ?? ''
    setOverrides((prev) => {
      const cur = prev[selected]
      if (!cur || cur.fontSize === undefined) return prev
      const { fontSize: _drop, ...rest } = cur
      let nextEntry: FieldOverride = rest
      if (font && pdfField) {
        const effSize = resolveEffectiveFontSize(selected, undefined)
        const requiredH = computeRequiredBboxHeight(
          pdfField,
          currentValue,
          effSize,
          font,
        )
        // h は max(テンプレ h, requiredH)（縮小禁止）。y は触らない（手動移動位置を尊重）。
        const baseH = pdfField.bbox.h
        const finalH = Math.max(baseH, requiredH)
        nextEntry = { ...rest, h: finalH }
      }
      const next = { ...prev }
      if (
        nextEntry.x === undefined &&
        nextEntry.y === undefined &&
        nextEntry.w === undefined &&
        nextEntry.h === undefined
      ) {
        delete next[selected]
      } else {
        next[selected] = nextEntry
      }
      return next
    })
  }, [selected, pushUndo, pdfFields, pageNumber, resolveEffectiveFontSize])

  // ── 全体の文字サイズ 手動編集 ───────────────────────────────────────────
  // 永続は bbox_overrides の予約キー __uniform__。優先順位: 手動 > 自動 snap > 素 uniform。
  // 範囲外はハードクランプ + 通知（aria-live で読み上げ）。
  const [uniformOverrideNotice, setUniformOverrideNotice] = useState<string | null>(null)
  const uniformNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (uniformNoticeTimerRef.current !== null) {
        clearTimeout(uniformNoticeTimerRef.current)
      }
    }
  }, [])

  const flashUniformNotice = useCallback((msg: string) => {
    setUniformOverrideNotice(msg)
    if (uniformNoticeTimerRef.current !== null) {
      clearTimeout(uniformNoticeTimerRef.current)
    }
    uniformNoticeTimerRef.current = setTimeout(() => {
      setUniformOverrideNotice(null)
      uniformNoticeTimerRef.current = null
    }, 3000)
  }, [])

  // 全体の文字サイズ手動値をセットする（pt）。範囲外はハードクランプして通知。null で「自動に戻す」。
  const onUniformOverrideChange = useCallback(
    (pt: number | null) => {
      pushUndo('other', null)
      if (pt === null) {
        setOverrides((prev) => writeUniformOverridePt(prev, null))
        setUniformOverrideNotice(null)
        return
      }
      const clamped = clampUniformOverridePt(pt)
      if (isOutOfRange(pt)) {
        flashUniformNotice(
          `${RANGE_MIN}〜${RANGE_MAX}pt の範囲で指定してください（${clamped}pt に補正しました）`,
        )
      } else {
        setUniformOverrideNotice(null)
      }
      setOverrides((prev) => writeUniformOverridePt(prev, clamped))
    },
    [pushUndo, flashUniformNotice],
  )

  const onUniformOverrideStep = useCallback(
    (delta: number) => {
      // 現在表示値（手動値 ?? 自動算出 ?? 既定 12pt）を基点に ±1pt。
      const baseRaw = uniformOverridePt ?? fieldValuesUniformFontSize ?? 12
      const base = Math.round(baseRaw)
      onUniformOverrideChange(base + delta)
    },
    [uniformOverridePt, fieldValuesUniformFontSize, onUniformOverrideChange],
  )

  const onUniformOverrideReset = useCallback(() => {
    if (uniformOverridePt === null) return
    onUniformOverrideChange(null)
  }, [uniformOverridePt, onUniformOverrideChange])

  // 「項目を追加」。name は nextClientFieldName で衝突回避、bbox は centeredNewBbox。
  // 追加直後の selected 化 + labelEditingName で即 label 編集モードへ。
  // newFieldNames Set に追加 → buildSavePayload で newFields payload 構築 / 削除時の整合。
  // undo: pushUndo('other') で snapshot 退避。件数ガード: FIELDS_MAX(20)。
  const handleAddField = useCallback(() => {
    if (fieldsRef.current.length >= FIELDS_MAX) return
    if (pageSizes.length === 0) return
    const meta = pageSizes[0]
    pushUndo('other', selected)
    const used = new Set(fieldsRef.current.map((f) => f.name))
    const name = nextClientFieldName(used)
    const bb = centeredNewBbox(meta)
    const newField: TemplateFieldDef = {
      name,
      label: placeholderLabel(fieldsRef.current.length),
      bbox: { x: bb.x, y: bb.y, w: bb.w, h: bb.h },
      multiline: false,
    }
    setFields((prev) => [...prev, newField])
    setNewFieldNames((prev) => {
      const next = new Set(prev)
      next.add(name)
      return next
    })
    setValues((prev) => ({ ...prev, [name]: '' }))
    setSelected(name)
    setLabelEditingName(name)
  }, [pageSizes, selected, pushUndo])

  // label インライン入力の変更（max LABEL_MAX）。
  const handleLabelChange = useCallback((name: string, value: string) => {
    const clipped = value.slice(0, LABEL_MAX)
    setFields((prev) =>
      prev.map((f) => (f.name === name ? { ...f, label: clipped } : f)),
    )
  }, [])

  // label インライン入力の確定。空のままなら「項目N」を仮置き。
  const handleLabelCommit = useCallback(() => {
    const target = labelEditingName
    if (!target) return
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
    setLabelEditingName(null)
  }, [labelEditingName])

  // 項目削除。最後の 1 項目は disabled。確認ダイアログなし即削除。fields / values / overrides 同時除去。
  // pushUndo で snapshot 退避 → 戻るで復元可能。newFieldNames Set からも当該 name を除去する
  // （追加直後 → 削除 → 保存で newFields payload に含まれず DB へ反映されない）。
  const handleDeleteSelected = useCallback(() => {
    if (!selected) return
    if (fieldsRef.current.length <= 1) return
    const name = selected
    pushUndo('other', name)
    setFields((prev) => prev.filter((f) => f.name !== name))
    setValues((prev) => {
      if (!(name in prev)) return prev
      const next = { ...prev }
      delete next[name]
      return next
    })
    setOverrides((prev) => {
      if (!(name in prev)) return prev
      const next = { ...prev }
      delete next[name]
      return next
    })
    setNewFieldNames((prev) => {
      if (!prev.has(name)) return prev
      const next = new Set(prev)
      next.delete(name)
      return next
    })
    setSelected(null)
  }, [selected, pushUndo])

  // dirty 判定（初期 snapshot との差分・エディタ部のみ）。title / meetingDate は本体で OR する。
  const editorDirty = useMemo(
    () =>
      !snapshotsEqual(
        { values, overrides, fields, newFieldNames },
        initialSnapshot.current,
      ),
    [values, overrides, fields, newFieldNames],
  )

  // newFields payload 構築。fields のうち newFieldNames に含まれる名前のものを PdfField[] に組む。
  const buildSavePayload = useCallback((): {
    content: Record<string, string>
    overrides: BboxOverrides
    newFields?: PdfField[]
  } => {
    const out: PdfField[] = []
    for (const f of fields) {
      if (!newFieldNames.has(f.name)) continue
      const pf = buildPdfFieldFromDefaults({
        name: f.name,
        label: f.label,
        bbox: {
          page: pageNumber,
          x: f.bbox.x,
          y: f.bbox.y,
          w: f.bbox.w,
          h: f.bbox.h,
        },
        multiline: f.multiline ?? false,
      })
      out.push(pf)
    }
    return {
      content: values,
      overrides,
      newFields: out.length > 0 ? out : undefined,
    }
  }, [fields, newFieldNames, values, overrides, pageNumber])

  // bbox.h マウント初期化（旧議事録マイグレーション含む）。
  // previewFont ロード完了かつ pdfFields 取得後に一度だけ overrides.h を初期化する。
  // ガード: h と y の両方が既にある場合のみ skip（手動調整尊重）。
  //   - h あり y なし → 旧議事録マイグレーション経路（中央維持 y を再計算）
  //   - h なし → 新規初期化経路（requiredH 算出 + shiftY）
  // h は max(テンプレ h, requiredH) で縮小禁止。y シフトは computeBboxCenteredYShift で拡張時のみ。
  const bboxHeightInitializedRef = useRef(false)
  useEffect(() => {
    if (bboxHeightInitializedRef.current) return
    if (!previewFont) return
    if (fields.length === 0) return
    if (pdfFields.length === 0) return

    bboxHeightInitializedRef.current = true
    setOverrides((prev) => {
      let changed = false
      const next: BboxOverrides = { ...prev }
      for (const f of fields) {
        const cur = prev[f.name] ?? {}
        if (cur.h !== undefined && cur.y !== undefined) continue
        // 新規追加 field（pdfFields に無い）も runtime 合成して経路継続させる。
        const pdfField =
          pdfFields.find((p) => p.name === f.name) ??
          synthesizePdfFieldFromTemplateDef(f, pageNumber)
        const baseH = pdfField.bbox.h
        const baseY = pdfField.bbox.y
        let effectiveH: number
        if (cur.h !== undefined) {
          effectiveH = cur.h
        } else {
          const v = valuesRef.current[f.name] ?? ''
          const effSize =
            cur.fontSize ?? uniformFontSizeRef.current ?? pdfField.font.size
          effectiveH = computeRequiredBboxHeight(
            pdfField,
            v,
            effSize,
            previewFont,
          )
        }
        // h は max(テンプレ h, requiredH)（縮小禁止）。素 baseY 起点で中央維持 y を書き込む。
        const finalH = Math.max(baseH, effectiveH)
        const shiftY = computeBboxCenteredYShift(baseH, finalH)
        const newY = baseY + shiftY
        next[f.name] = { ...cur, h: finalH, y: newY }
        changed = true
      }
      return changed ? next : prev
    })
  }, [previewFont, fields, pdfFields, pageNumber])

  // bbox 直接クリック後の textarea autoFocus。
  useEffect(() => {
    if (selected && textareaRef.current) {
      textareaRef.current.focus({ preventScroll: false })
    }
  }, [selected, textareaRef])

  // Ctrl+Z / Ctrl+Shift+Z。input/textarea フォーカス中はブラウザのテキスト undo に譲る。
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName
      const inEditable =
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        (e.target as HTMLElement | null)?.isContentEditable === true
      if (!inEditable && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) handleRedo()
        else handleUndo()
        return
      }
      if (inEditable) return
      if (!selected) return
      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault()
          applyNudgeAction('move-up')
          break
        case 'ArrowDown':
          e.preventDefault()
          applyNudgeAction('move-down')
          break
        case 'ArrowLeft':
          e.preventDefault()
          applyNudgeAction('move-left')
          break
        case 'ArrowRight':
          e.preventDefault()
          applyNudgeAction('move-right')
          break
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selected, applyNudgeAction, handleUndo, handleRedo])

  return {
    fields,
    values,
    overrides,
    selected,
    setSelected,
    newFieldNames,
    labelEditingName,
    isDragging,
    editorFields,
    hasAnyOverride,
    selectedOnlyBgUrl,
    uniformOverridePt,
    fieldValuesUniformFontSize,
    dynamicFieldValues,
    dirty: editorDirty,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    uniformOverrideNotice,
    undo: handleUndo,
    redo: handleRedo,
    onValueChange,
    setValues,
    applyNudgeAction,
    applyCenterHorizontal,
    onFontSizeStep,
    onFontSizeReset,
    onUniformOverrideChange,
    onUniformOverrideStep,
    onUniformOverrideReset,
    handleAddField,
    handleLabelChange,
    handleLabelCommit,
    handleDeleteSelected,
    handleChangeBbox,
    handleDragStart,
    handleDragCommit,
    buildSavePayload,
    pushUndoOther: useCallback((name: string | null) => pushUndo('other', name), [pushUndo]),
  }
}
