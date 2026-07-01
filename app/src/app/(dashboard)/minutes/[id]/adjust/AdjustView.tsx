'use client'

/**
 * 統合 AdjustView — 議事録の値入力 + bbox 位置 / サイズ調整画面。
 *
 * 編集状態（値 / 位置 / サイズ / 整形 / 項目追加削除 / undo-redo）は useMinuteAdjustEditor hook に
 * 集約し、本体は「タイトル / 開催日 + 周辺 state + 取得 effect + 保存ライフサイクル + JSX」を持つ。
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
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { saveMinuteAdjust, updateMinute } from '@/server/minutes'
import {
  type FieldOverride,
  type BboxOverrides,
} from '@/lib/pdf-output/field-override'
import type { FittableFont } from '@/lib/pdf-output/fitting'
import { type PageMeta, BUILTIN_SYNTHETIC_A4_PAGE } from '@/lib/pdf-output/bbox-coords'
import { UndoRedoButtons } from '@/components/editor/UndoRedoButtons'
import { ZoomPanel } from '@/components/editor/ZoomPanel'
import BboxPane, {
  type SelectionGeom,
} from '@/app/(dashboard)/templates/[id]/bbox-pane'
import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'
import { MinutesFieldInspector } from './_components/MinutesFieldInspector'
import { UniformFontSizeSection } from './_components/UniformFontSizeSection'
import { useToast } from '@/components/toast/toast-context'
import { useMinuteAdjustEditor } from '@/hooks/editor/useMinuteAdjustEditor'
import { UnsavedChangesModal } from '@/components/editor/UnsavedChangesModal'
import type { UseGuestTurnstileGate } from '@/hooks/useGuestTurnstileGate'

export type TemplateFieldDef = {
  name: string
  label: string
  bbox: { x: number; y: number; w: number; h: number }
  multiline?: boolean
}

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

/** fields 配列の上限。20 で「項目を追加」disabled（hook の handleAddField ガードと一致）。 */
const FIELDS_MAX = 20

/** FloatingShell 幅追従スケール基準（templates `widthToScale` 同方式）。 */
const FLOATING_BASE_WIDTH_PX = 470

function widthToScale(effectiveWidth: number): number {
  const s = effectiveWidth / FLOATING_BASE_WIDTH_PX
  return Math.max(0.5, Math.min(1, s))
}

type Tone = 'omakase' | 'calm' | 'polite' | 'bright' | 'custom'

/**
 * 動的プレビュー: その field 自身の override.fontSize（自動なら fallback 12pt）と
 * bbox 高さの 70% のうち、小さい方を返す純関数（互換のため export 維持）。
 */
export function computePreviewFontSize(
  bboxH: number,
  ownFontSize: number | undefined,
): number {
  const requested = ownFontSize ?? 12
  return Math.min(bboxH * 0.7, requested)
}

/**
 * bbox 移動 RAF 間引き（案 A）: handleChangeBbox の中核 reducer 純関数。
 *
 * Map 化された pointermove 累積 updates を BboxOverrides に畳み込む。flushBboxChanges 内の
 * setOverrides ロジックと単一実装にするため export してテストから直接呼べる。
 *
 * 仕様:
 *   - 各 update について fields から tmpl を name で lookup、無ければ skip（不存在 field 防御）。
 *   - x / y は常に上書き。w / h は tmpl 素値と異なるときのみ書く。
 *   - 1 件も適用しなかった場合は prev をそのまま返す（参照同一 = 不要な再 render 抑止）。
 */
export function applyBboxFlushUpdates(
  prev: BboxOverrides,
  updates: Map<string, { x: number; y: number; w: number; h: number; page: number }>,
  fields: TemplateFieldDef[],
): BboxOverrides {
  if (updates.size === 0) return prev
  let next = prev
  let mutated = false
  updates.forEach((bbox, name) => {
    const tmpl = fields.find((f) => f.name === name)
    if (!tmpl) return
    const cur = next[name] ?? {}
    const entry: FieldOverride = { ...cur, x: bbox.x, y: bbox.y }
    if (bbox.w !== tmpl.bbox.w) entry.w = bbox.w
    if (bbox.h !== tmpl.bbox.h) entry.h = bbox.h
    if (!mutated) {
      next = { ...next }
      mutated = true
    }
    next[name] = entry
  })
  return mutated ? next : prev
}

/**
 * bbox.h を素 baseH → newH に拡張する際、bbox.y を shift して縦中央位置を維持する純関数。
 * 縮小（newH <= baseH）では y を動かさない（0 を返す）。
 *   - D8 旧式 (baseH - newH) / 2 は拡張時のみ意味がある（中央維持で y を上シフト）。
 *   - 縮小時にも適用すると「テンプレ余裕のある field を勝手に下シフト」+「手動移動位置を即上書き」+
 *     「fontSize 変更で元位置に戻る」副作用が出るため、縮小時は shiftY=0。
 * 呼び出し側で effectiveH = max(baseH, requiredH) と併用するため、newH <= baseH なら 0 を返すだけで
 * 「縮小しない」運用とセットで整合する。required-bbox-height.ts は触らない。
 */
export function computeBboxCenteredYShift(baseH: number, newH: number): number {
  if (newH <= baseH) return 0
  return (baseH - newH) / 2
}

/**
 * BboxPane に渡す whiteoutRawImageUrl を組み立てる純関数。
 *   - isDragging=true: 案 D OFF（rawBgUrl 固定）。drag 中に selected が変わっても
 *     whiteoutRawImageUrl は不変 → bbox-pane.tsx の rawImg ロード useEffect が再走しない →
 *     setRawImg(null) によるブランクアウトが構造的に起きない。
 *   - isDragging=false: 案 D 通常経路（selectedOnlyBgUrl ?? rawBgUrl）。
 * 背景未取得（rawBgUrl=null）の場合は null を返す。
 */
export function resolveWhiteoutRawImageUrl(
  isDragging: boolean,
  rawBgUrl: string | null,
  selectedOnlyBgUrl: string | null,
): string | null {
  if (isDragging) return rawBgUrl
  return selectedOnlyBgUrl ?? rawBgUrl
}

/**
 * dynamicFieldValues（client canvas 合成に乗せる記入値）に、ある field を含めるか判定する純関数。
 *
 * ── 不変条件: A∩B=∅ を構造保証する ──────────────────────────────────────
 * A = 背景PNG（selectedOnlyBgUrl=_raw_except_<selected>）に焼かれる field 集合 = 全field − {selected}
 * B = client 合成する field 集合（本関数が true を返す field 群）
 * compositeFieldValuesOnCanvas は fillText 重ね描き（背景ピクセルを消さない）ため、
 * A∩B≠∅ の field は「背景PNG(DB位置)」+「client(override位置)」で二重描画される。
 *
 * hasOverride 分岐は撤回済み（二重描画の張本人だった）。絶対に復活させない。override 残留時の
 * 二重描画は、呼出側で hasAnyOverride 時に selected を null にして selectedOnlyBgUrl を生成させない
 * ことで A∩B=∅ を構造保証する。
 *
 * 判定:
 *   - useSelectedOnly = !isDragging && selected !== null && selectedOnlyBgUrl !== null
 *       isDragging 中は必ず false → 全 field を override 付きで client 合成しスナップに焼く。
 *   - 含める条件: !useSelectedOnly || field === selected
 *       useSelectedOnly のとき B={selected}・A=全field−{selected} で A∩B=∅。
 *   selectedOnlyBgUrl が null のときは useSelectedOnly=false で全 field を client 合成
 *   （B=全field・A=rawBgUrl(空集合)で A∩B=∅）。両ケースで A∩B=∅ が成立する。
 */
export function shouldComposeFieldClientSide(args: {
  fieldName: string
  selected: string | null
  selectedOnlyBgUrl: string | null
  isDragging: boolean
}): boolean {
  const { fieldName, selected, selectedOnlyBgUrl, isDragging } = args
  const useSelectedOnly = !isDragging && selected !== null && selectedOnlyBgUrl !== null
  if (!useSelectedOnly) return true
  if (fieldName === selected) return true
  return false
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
  const router = useRouter()
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

  // ── 本体維持 state（タイトル / 開催日 + プレゼンテーション層 + 整形 SSE）──────
  const [title, setTitle] = useState<string>(initialTitle)
  const [meetingDate, setMeetingDate] = useState<string>(initialMeetingDate)
  const [rawBgUrl, setRawBgUrl] = useState<string | null>(null)
  const [pageSizes, setPageSizes] = useState<PageMeta[]>([])
  const [saving, setSaving] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  // 「閲覧画面に戻る」未保存ガードモーダル (bbox-editor と同型・共通モーダル経由)。
  const [leaveGuardOpen, setLeaveGuardOpen] = useState(false)
  const [leaveSaving, setLeaveSaving] = useState(false)
  const [leaveSaveError, setLeaveSaveError] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pdfDisplayWidth, setPdfDisplayWidth] = useState<number | null>(null)
  const [formatting, setFormatting] = useState<string | null>(null)
  const [showGrid, setShowGrid] = useState(false)
  // selectionGeom は BboxPane が内部的にラベル左上表示に使う。本体側では現状未使用（将来用）。
  const [selectionGeom, setSelectionGeom] = useState<SelectionGeom | null>(null)
  // 動的プレビュー用の OTF フォント（opentype.js 経由）。null = ロード未完了 / 失敗 → fallback。
  const [previewFont, setPreviewFont] = useState<FittableFont | null>(null)
  const [tones, setTones] = useState<Record<string, Tone>>(() =>
    Object.fromEntries(initialFields.map((f) => [f.name, 'omakase' as Tone])),
  )
  const [customTexts, setCustomTexts] = useState<Record<string, string>>(() =>
    Object.fromEntries(initialFields.map((f) => [f.name, ''])),
  )

  // textarea ref は BboxPane と Inspector の両方が触るため本体管理。autoFocus effect は hook 内。
  const textareaRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null)

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

  // ── 背景 raw PNG 取得 ─────────────────────────────────────────────────────
  // 通常: /api/minutes/[id]/render-image を raw=true で呼ぶ（記入値ゼロの背景・signedUrl 応答）。
  // guestMode: renderImageEndpoint（既定 /api/guest/render-image）を builtin templateId 付きで
  //   叩く。応答は PNG bytes 直返しのため signedUrl ではなく objectURL 化して使う。
  useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null
    async function load() {
      try {
        if (guestMode) {
          const endpoint = renderImageEndpoint ?? '/api/guest/render-image'
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify({
              templateId,
              content: {},
              overrides: {},
              raw: true,
            }),
          })
          if (!res.ok) return
          const blob = await res.blob()
          if (cancelled) return
          objectUrl = URL.createObjectURL(blob)
          setRawBgUrl(objectUrl)
          return
        }
        const endpoint = renderImageEndpoint ?? `/api/minutes/${minuteId}/render-image`
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify({
            dpi: 150,
            format: 'png',
            pageRange: { from: 1, to: 1 },
            raw: true,
          }),
        })
        if (!res.ok) return
        const json: { signedUrl?: string } = await res.json()
        if (!cancelled && json.signedUrl) setRawBgUrl(json.signedUrl)
      } catch {
        // 背景取得失敗はサイレント（操作は動かす）。
      }
    }
    void load()
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [minuteId, templateId, guestMode, renderImageEndpoint])

  // 動的プレビュー vs PDF 完全一致用の OTF をロード（opentype.js + Noto Sans JP subset を遅延 import）。
  // ロード失敗時は previewFont=null 維持 → fallback（ctx.measureText 経路・劣化プレビュー）。
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const mod = await import('@/lib/parsers/pdf/preview-font-loader')
        const font = await mod.loadPreviewFont()
        if (!cancelled && font) setPreviewFont(font)
      } catch {
        // サイレント fallback（ctx.measureText 経路で UI は動く）。
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // ── pageSizes 取得（templates bbox-editor route を流用・OCR を呼ばない軽量ラスタライズ）──
  // guestMode: 認証必須の bbox-editor route を呼ばず、builtin 固定の A4 ページサイズを即使う
  //   （builtin は source_format !== 'pdf' のため、認証ありで叩いても同じ固定値が返る＝等価）。
  useEffect(() => {
    if (guestMode) {
      setPageSizes([BUILTIN_SYNTHETIC_A4_PAGE])
      return
    }
    let cancelled = false
    async function loadPageSizes() {
      try {
        const res = await fetch(`/api/templates/${templateId}/bbox-editor`, {
          method: 'GET',
          cache: 'no-store',
        })
        if (!res.ok) return
        const json: { pageSizes?: PageMeta[]; editable?: boolean } =
          await res.json()
        if (!cancelled && Array.isArray(json.pageSizes)) {
          setPageSizes(json.pageSizes)
        }
      } catch {
        // pageSizes が取れないと BboxPane は描画されない（フォールバック後述）。
      }
    }
    void loadPageSizes()
    return () => {
      cancelled = true
    }
  }, [templateId, guestMode])

  // dirty = エディタ部（hook）+ タイトル / 開催日（本体）の boolean OR。
  // metaDirty は文字列比較 2 回なので hot path 化しない（useMemo すら不要）。
  const metaDirty = title !== initialTitle || meetingDate !== initialMeetingDate
  const dirty = editor.dirty || metaDirty

  // 整形 SSE（ManualForm.onFormat 移植）。値が変わるだけなので hook の onValueChange 相当の
  // value coalesce ではなく、'other' で 1 ステップ退避してから SSE delta を setValues で流す。
  async function onFormat(name: string) {
    const raw = editor.values[name]?.trim()
    if (!raw) {
      setErrorMsg(`${labelOf(name)} に内容を入力してから整形してください`)
      return
    }
    if (tones[name] === 'custom' && !customTexts[name]?.trim()) {
      setErrorMsg('整え方「自由」の指示を入力してください')
      return
    }
    setFormatting(name)
    setErrorMsg(null)
    editor.pushUndoOther(name)
    try {
      // guest 時のみ Turnstile トークンを await。gate 未指定（ログインユーザー）は undefined 即
      // return なので、body に turnstileToken フィールドは一切乗らない（回帰テスト対象）。
      const capturedToken = guestTurnstileGate
        ? await guestTurnstileGate.consumeToken()
        : undefined
      const res = await fetch('/api/minutes/format-item', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          field_name: name,
          raw_text: raw,
          tone: tones[name],
          ...(tones[name] === 'custom'
            ? { custom_text: customTexts[name].trim() }
            : {}),
          ...(capturedToken !== undefined ? { turnstileToken: capturedToken } : {}),
        }),
      })
      if (!res.ok || !res.body) {
        // 失敗時は次回チャレンジを明示発火（gate 未指定なら no-op）。
        guestTurnstileGate?.reset()
        throw new Error('FORMAT_FAILED')
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let accumulated = ''
      let receivedAny = false
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n\n')
        buffer = lines.pop() ?? ''
        for (const block of lines) {
          const line = block.startsWith('data: ') ? block.slice(6) : block
          if (!line.trim()) continue
          try {
            const evt = JSON.parse(line)
            if (evt.type === 'delta' && typeof evt.text === 'string') {
              if (!receivedAny) {
                accumulated = ''
                receivedAny = true
              }
              accumulated += evt.text
              editor.setValues((prev) => ({ ...prev, [name]: accumulated }))
            } else if (evt.type === 'error') {
              throw new Error(evt.message ?? 'stream_error')
            }
          } catch {
            // 部分受信のパースエラーは次フレームで回復
          }
        }
      }
      if (!receivedAny) throw new Error('NO_OUTPUT')
    } catch {
      setErrorMsg('整形に失敗しました。少し時間を置いて再度お試しください。')
    } finally {
      setFormatting(null)
    }
  }

  /**
   * 議事録保存（記入欄 + meta）を 1 関数に集約。
   *   - バリデーション（title 必須・meetingDate YYYY-MM-DD）
   *   - editor.buildSavePayload() → saveMinuteAdjust
   *   - metaDirty 時のみ updateMinute（順序固定: saveMinuteAdjust 後）
   *
   * エラーは throw せず PersistResult で返す。呼出側は ok=true 時に router.push、
   * ok=false 時に固有の error state へ userMessage を入れる。これにより onSave() は
   * トースト + 画面エラー、モーダル経路はモーダル内 error と振り分けを呼出側に閉じ込められる。
   */
  type PersistResult =
    | { ok: true }
    | { ok: false; userMessage: string; cause: unknown }

  async function persistMinute(): Promise<PersistResult> {
    if (!title.trim()) {
      return { ok: false, userMessage: 'タイトルを入力してください', cause: 'VALIDATION_TITLE' }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(meetingDate)) {
      return { ok: false, userMessage: '開催日を入力してください', cause: 'VALIDATION_DATE' }
    }
    try {
      // newFields は 1 件以上のときだけ payload に含む（hook の buildSavePayload で構築）。
      // 0 件: saveMinuteAdjust.newFields=undefined で既存 new_fields を保持。
      const payload = editor.buildSavePayload()
      await saveMinuteAdjust({
        id: minuteId,
        content: payload.content,
        overrides: payload.overrides,
        newFields: payload.newFields,
      })
      // タイトル / 開催日に変更があれば updateMinute で別途保存。
      //   - content は送らないため updateMinute 内 regenerate は走らない。
      //   - saveMinuteAdjust が成功した後に呼ぶ（順序逆だと title 失敗時に content だけ保存される）。
      if (metaDirty) {
        await updateMinute({
          id: minuteId,
          title: title.trim(),
          meetingDate,
        })
      }
      return { ok: true }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[AdjustView.persistMinute] failed:', e)
      const userMessage = msg === 'MINUTE_UPDATE_NOT_PERSISTED'
        ? '保存できませんでした。もう一度お試しいただき、続く場合は再ログインしてください。'
        : '保存に失敗しました。少し時間を置いて再度お試しください。'
      return { ok: false, userMessage, cause: e }
    }
  }

  /** guestMode 保存ボタンが onGuestSave へ渡す draft を組み立てる。DB へは一切触れない。 */
  function buildGuestDraft(): GuestMinuteDraft {
    const payload = editor.buildSavePayload()
    return {
      templateId,
      title: title.trim(),
      meetingDate,
      content: payload.content,
      overrides: payload.overrides,
      newFields: payload.newFields,
    }
  }

  async function onSave() {
    if (guestMode) {
      onGuestSave?.(buildGuestDraft())
      return
    }
    setSaving(true)
    setErrorMsg(null)
    const result = await persistMinute()
    if (result.ok) {
      router.push(`/minutes/${minuteId}`)
      return
    }
    setErrorMsg(result.userMessage)
    // バリデーション失敗（API 未到達）ではトーストを出さず画面エラーのみ。
    // 既存挙動を維持するため API 失敗時のみトースト発火。
    if (result.cause !== 'VALIDATION_TITLE' && result.cause !== 'VALIDATION_DATE') {
      showToast('error', result.userMessage)
    }
    setSaving(false)
  }

  /**
   * モーダル「保存して移動」。
   * guestMode: persistMinute は UNAUTHENTICATED で必ず失敗するため onSave と同じ分岐で
   *   onGuestSave に差し替える。form-cache 退避 + /login 遷移は呼出側（GuestAdjustBootstrap）の
   *   責務なので、ここではモーダルを閉じるだけでよい。
   * 通常: 同じ persistMinute() を呼び、結果をモーダル内 error に振り分け。
   */
  async function handleLeaveSaveAndBack() {
    if (guestMode) {
      setLeaveGuardOpen(false)
      onGuestSave?.(buildGuestDraft())
      return
    }
    setLeaveSaving(true)
    setLeaveSaveError(null)
    const result = await persistMinute()
    if (result.ok) {
      setLeaveGuardOpen(false)
      router.push(`/minutes/${minuteId}`)
      return
    }
    // モーダルに留まり、モーダル内 error にのみ表示（トースト・画面エラーは出さない）。
    setLeaveSaveError(result.userMessage)
    setLeaveSaving(false)
  }

  /**
   * モーダル「保存せず移動」: 未保存を破棄して戻る。
   * guestMode はゲストが保存済み minute を持たず「閲覧画面」に相当する行き先が無いため、
   * テンプレ選択画面（/templates・未ログインでもアクセス可）へ戻す。
   */
  function handleLeaveDiscardAndBack() {
    setLeaveGuardOpen(false)
    router.push(guestMode ? '/templates' : `/minutes/${minuteId}`)
  }

  function labelOf(name: string): string {
    return editor.fields.find((f) => f.name === name)?.label ?? name
  }

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
  const handleBackToViewerClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!dirty) return
    e.preventDefault()
    setLeaveSaveError(null)
    setLeaveGuardOpen(true)
  }

  return (
    <div className="space-y-3">
      {/* 閲覧画面への戻り導線。guestMode は保存済み minute を持たないためテンプレ選択画面へ。 */}
      <div className="flex items-center gap-3">
        <Link
          href={guestMode ? '/templates' : `/minutes/${minuteId}`}
          onClick={handleBackToViewerClick}
          className="text-sm text-gizirotto-blue-700 hover:underline"
        >
          {guestMode ? '← テンプレ選択に戻る' : '← 閲覧画面に戻る'}
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
            value={title}
            onChange={(e) => setTitle(e.target.value)}
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
            value={meetingDate}
            onChange={(e) => setMeetingDate(e.target.value)}
            className="mt-1 border border-gizirotto-blue-200 rounded px-3 py-2 text-base"
            required
          />
        </div>
      </div>

      {/* ヘッダー: 説明文 ↔ ボタン列を横並び右寄せ。
          ボタン列順序: [グリッド表示] → [← 戻る][進む →] → [項目を追加] → [キャンセル] → [保存]。 */}
      <div className="flex items-center justify-between gap-3 flex-wrap sm:flex-nowrap pb-1">
        <p className="text-sm text-gray-600 sm:flex-1 sm:min-w-0">
          項目をタップして選び、値・位置・大きさを調整してください。
        </p>
        <div className="flex items-center gap-3 sm:shrink-0">
          <button
            type="button"
            onClick={() => setShowGrid((v) => !v)}
            aria-pressed={showGrid}
            className={
              'text-sm font-medium px-3 py-2 rounded border ' +
              (showGrid
                ? 'bg-gizirotto-blue-500 border-gizirotto-blue-500 text-white'
                : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50')
            }
          >
            グリッド表示
          </button>
          <UndoRedoButtons
            onUndo={editor.undo}
            onRedo={editor.redo}
            canUndo={editor.canUndo && !saving}
            canRedo={editor.canRedo && !saving}
          />
          <button
            type="button"
            onClick={editor.handleAddField}
            disabled={editor.fields.length >= FIELDS_MAX || saving}
            title={
              editor.fields.length >= FIELDS_MAX ? '項目は20個までです' : undefined
            }
            className="bg-white border border-gizirotto-blue-500 text-gizirotto-blue-700 hover:bg-gizirotto-blue-500/10 font-medium px-3 py-2 rounded text-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            項目を追加
          </button>
          <button
            type="button"
            onClick={() => router.back()}
            disabled={saving}
            className="text-sm text-gray-600 hover:text-gray-800"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={!dirty || saving}
            className="bg-gizirotto-blue-500 hover:bg-gizirotto-blue-700 text-white font-medium px-3 py-2 rounded text-sm disabled:opacity-50"
          >
            {saving ? '保存中…' : guestMode ? 'ログインして保存' : '保存'}
          </button>
        </div>
      </div>

      {/* PC: 2 カラム grid（左=プレビュー / 右=aside 固定パネル）/ スマホ: プレビューのみ + 下バー */}
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_320px] gap-4 items-start">
        <div>
          {pageSizes.length > 0 ? (
            pageSizes.map((meta) => (
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
                onSelectionGeom={setSelectionGeom}
                zoom={zoom}
                variant="field"
                // ドラッグ中レイヤ凍結: adjust だけ ON（templates 側 BboxPane 呼びには渡さない＝false）。
                freezeDragLayer
                whiteoutRawImageUrl={resolveWhiteoutRawImageUrl(
                  editor.isDragging,
                  rawBgUrl,
                  editor.selectedOnlyBgUrl,
                )}
                onDisplayWidth={setPdfDisplayWidth}
                dynamicFieldValues={editor.dynamicFieldValues}
                fieldValuesUniformFontSize={editor.fieldValuesUniformFontSize}
                fieldValuesPreviewFont={previewFont ?? undefined}
                showGrid={showGrid}
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
              <MinutesFieldInspector
                field={selectedField}
                value={editor.values[selectedField.name] ?? ''}
                onValueChange={(v) => editor.onValueChange(selectedField.name, v)}
                tone={tones[selectedField.name] ?? 'omakase'}
                onToneChange={(t) =>
                  setTones((prev) => ({ ...prev, [selectedField.name]: t }))
                }
                customText={customTexts[selectedField.name] ?? ''}
                onCustomTextChange={(v) =>
                  setCustomTexts((prev) => ({
                    ...prev,
                    [selectedField.name]: v.slice(0, 200),
                  }))
                }
                onFormat={() => onFormat(selectedField.name)}
                formatting={formatting === selectedField.name}
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
                compact
              />
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
          className="md:hidden fixed inset-x-0 bottom-14 z-30 flex justify-center px-3 pointer-events-none"
        >
          <div
            className="pointer-events-auto bg-white/95 border border-gray-200 rounded-lg px-2.5 py-2 shadow-lg max-h-[50vh] overflow-y-auto"
            style={
              pdfDisplayWidth && pdfDisplayWidth > 0
                ? { width: `min(${Math.round(pdfDisplayWidth)}px, calc(100vw - 24px))` }
                : undefined
            }
          >
            <MinutesFieldInspector
              field={selectedField}
              value={editor.values[selectedField.name] ?? ''}
              onValueChange={(v) => editor.onValueChange(selectedField.name, v)}
              tone={tones[selectedField.name] ?? 'omakase'}
              onToneChange={(t) =>
                setTones((prev) => ({ ...prev, [selectedField.name]: t }))
              }
              customText={customTexts[selectedField.name] ?? ''}
              onCustomTextChange={(v) =>
                setCustomTexts((prev) => ({
                  ...prev,
                  [selectedField.name]: v.slice(0, 200),
                }))
              }
              onFormat={() => onFormat(selectedField.name)}
              formatting={formatting === selectedField.name}
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
              dense
              scale={phoneScale}
            />
          </div>
        </div>
      )}

      {/* selectionGeom は BboxPane が内部的にラベル左上表示に使う。本体側では現状未使用。 */}
      {selectionGeom && <span className="hidden" data-selection-geom="true" />}

      {errorMsg && (
        <p className="text-sm text-red-600" role="alert">
          {errorMsg}
        </p>
      )}

      <ZoomPanel zoom={zoom} onZoom={setZoom} />

      {/* 閲覧画面戻り導線の未保存ガード共通モーダル (bbox-editor と同型)。 */}
      <UnsavedChangesModal
        open={leaveGuardOpen}
        description="閲覧画面に戻る前に、編集した内容を保存しますか？"
        onSave={handleLeaveSaveAndBack}
        onDiscard={handleLeaveDiscardAndBack}
        onCancel={() => setLeaveGuardOpen(false)}
        saving={leaveSaving}
        error={leaveSaveError}
      />
    </div>
  )
}
