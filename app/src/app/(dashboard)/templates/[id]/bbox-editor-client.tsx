'use client'

/**
 * bbox エディタ クライアント本体（G2-1 設計書 v0.2 §2-2 / §2-3 / §2-5）。
 *
 * 責務:
 *   - GET /api/templates/[id]/bbox-editor で初期データ取得（背景/pageSizes/fields/version）
 *   - 選択状態（selectedName）・編集中 fields（pt 空間・丸めなし）の state 管理
 *   - 「変更あり」表示（初期スナップショットとの差分）＋ beforeunload 離脱警告
 *   - キーボード矢印（移動）/ Shift+矢印（リサイズ）＋ nudge ボタン（移動 4・サイズ 4）
 *   - 明示「保存」ボタンのみ DB 更新（操作中 DB 不変）。楽観ロック CONFLICT を擬人化表示。
 *   - Q8 フォールバック（editable:false）= 「このテンプレは位置調整に対応していません」
 *
 * 1px = 元画像 px 基準（stepPt）。pt の加減算で ±4px を保証（§2-3 / §3）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  type PageMeta,
  type BboxPt,
  MIN_BBOX_PT,
  isWidgetEmergenceClick,
  CLICK_GUARD_MS,
} from '@/lib/pdf-output/bbox-coords'
import { useFieldLayerEditor } from '@/hooks/editor/useFieldLayerEditor'
import { useWhiteoutLayer } from '@/hooks/editor/useWhiteoutLayer'
import { useFixedLayer } from '@/hooks/editor/useFixedLayer'
import ErrorNotice from '@/components/error-notice'
import { UndoRedoButtons } from '@/components/editor/UndoRedoButtons'
import { UnsavedChangesModal } from '@/components/editor/UnsavedChangesModal'
import { ZoomPanel } from '@/components/editor/ZoomPanel'
import BboxPane, { type EditorField, type SelectionGeom } from './bbox-pane'
import {
  whiteoutBoxesToFields,
  fieldsToWhiteoutBoxes,
  type WhiteoutBoxInput,
} from '@/lib/pdf-output/whiteout-adapter'
import {
  fixedTextsToFields,
  fieldsToFixedTexts,
  type FixedText,
} from '@/lib/pdf-output/fixedtext-adapter'
import { FieldControlsBody } from './_components/FieldControlsBody'
import { FloatingNudge } from './_components/FloatingNudge'
import { FixedTextControlsBody } from './_components/FixedTextControlsBody'
import { FixedTextFloatingNudge } from './_components/FixedTextFloatingNudge'
import { WhiteoutControlsBody } from './_components/WhiteoutControlsBody'
import { WhiteoutFloatingNudge } from './_components/WhiteoutFloatingNudge'
import { SplitNamingPanel } from './_components/SplitNamingPanel'

/** 編集モード（設計書 §4-1 / C-2 §3-2）: 記入欄 / 白塗り / 固定テキストのレイヤ切替。 */
type EditMode = 'field' | 'whiteout' | 'fixed'

// 記入欄/白塗り/固定で共通の nudge/center は layer-ops.ts（nudgeSelected/centerSelected）へ集約済み。
// 記入欄レイヤの state/ref/handler は useFieldLayerEditor（hooks/editor）へ移送済み。

interface InitialData {
  fields: Array<{ name: string; label: string; bbox: BboxPt & { page: number } }>
  pageSizes: PageMeta[]
  previewImageUrls: (string | null)[]
  /**
   * ②動的プレビュー（§2-2）: 白塗りモードの canvas 用 raw 背景（合成なし）。
   * null（raw 非対応テンプレ）は previewImageUrls へフォールバック。
   */
  rawPreviewImageUrls?: (string | null)[] | null
  fieldsVersion: string
  /** 段階2 Phase 2-C（§2-1）: 白塗り編集モードの編集対象（左上原点pt・記入欄と同一座標系）。 */
  whiteoutBoxes?: WhiteoutBoxInput[]
  /** 段階2 C-2（§3-1）: 固定テキスト編集モードの編集対象（左上原点pt・記入欄と同一座標系）。 */
  fixedTexts?: FixedText[]
}

type Phase = 'loading' | 'ready' | 'unsupported' | 'error'

/**
 * fields 配列の上限（サーバ FIELDS_MAX と一致）。20 で「枠を追加」disabled。
 * 記入欄レイヤ自体は useFieldLayerEditor 内で同値を持つが、本体 JSX の分割可否/件数表示でも参照する。
 */
const FIELDS_MAX = 20

/** 一覧離脱ガード（#19）の保存対象 1 モード（dirty 判定・ラベル・save 実行関数）。 */
export interface LeaveSaveTask {
  /** dirty なら保存対象。false のモードはスキップ。 */
  dirty: boolean
  /** 失敗告知に出す日本語ラベル（例: 記入欄 / 白塗り / 固定テキスト）。 */
  label: string
  /** その モードの保存。成功 true・失敗 false を返す（DB 反映まで await 済み）。 */
  save: () => Promise<boolean>
}

/**
 * 「保存して移動」の一括保存（#19）。dirty なモードだけを**順次 await** で保存し、
 * 失敗したモードのラベル配列を返す（空＝全成功）。
 *
 * 順次（直列）に await する理由: 白塗りは raw 再焼き込み＋whiteout_boxes 更新＋サムネ再生成を
 * 含む重い保存で、記入欄/固定テキストの DB 更新と競合させない方が安全（各カラム独立だが直列で確実）。
 * router.push は呼び出し側が「戻り値が空配列のときだけ」行うこと（DB 反映完了後の遷移を保証）。
 */
export async function runLeaveSaves(tasks: LeaveSaveTask[]): Promise<string[]> {
  const failed: string[] = []
  for (const t of tasks) {
    if (!t.dirty) continue
    const ok = await t.save()
    if (!ok) failed.push(t.label)
  }
  return failed
}

/**
 * ②縦フィット基準高さの控除量（px・PY1-5 Q-Y3）。
 * window.innerHeight からヘッダ/保存バー/ズームパネル等の概算分を引き、
 * エディタ確保高（viewportHeight）を得る。デフォルト値は実機チューニング前提。
 */
const EDITOR_VIEWPORT_MARGIN_PX = 220

/**
 * 微調整4点・指示1（実機FB）: フローティングウィジェットが等倍（scale=1）で 3カラム
 * （位置｜大きさ｜そろえる）を横並びに収めるのに必要な実効幅(px・内側パディング除く)。
 * dense レイアウト実測: 位置グリッド(40*3+4*2≈128) + gap24 + 大きさ列(幅ラベル+ボタン2≈28+40*2+gap≈76)
 * + gap24 + そろえる列(中央寄せボタン・分割/削除 縦積み≈110) ＝ 約 470px。
 * これより狭い幅では scale = width / BASE_WIDTH で連続縮小し、折り返しを防ぐ。
 */
const FLOATING_BASE_WIDTH_PX = 470

/** ウィジェットが受け取った実効幅(px)から 3カラム維持用スケール係数を算出（下限 0.5・上限 1）。 */
function widthToScale(effectiveWidth: number): number {
  const s = effectiveWidth / FLOATING_BASE_WIDTH_PX
  return Math.max(0.5, Math.min(1, s))
}

export default function BboxEditorClient({
  templateId,
  backHref = '/templates',
}: {
  templateId: string
  /** 「一覧へ」戻り先（未保存ガード経由で遷移する・追加UX-C #19）。 */
  backHref?: string
}) {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('loading')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [unsupportedReason, setUnsupportedReason] = useState<string | null>(null)

  const [pageSizes, setPageSizes] = useState<PageMeta[]>([])
  const [imageUrls, setImageUrls] = useState<(string | null)[]>([])
  // ②動的プレビュー（§2-2）: 白塗りモードの canvas 用 raw 背景。null は焼込済へフォールバック。
  const [rawImageUrls, setRawImageUrls] = useState<(string | null)[]>([])
  // fieldsVersion は記入欄保存の楽観ロックに使う（全層共有 state なので本体維持・hook へ getter/setter 注入）。
  const [fieldsVersion, setFieldsVersion] = useState<string>('')

  // 段階2 Phase 2-C（設計書 §4-1）: 編集モード（記入欄 / 白塗り）。既定は記入欄＝従来挙動。
  const [mode, setMode] = useState<EditMode>('field')

  // 段階2 Phase 2-D 修正（実機FB）: PDF プレビューの実表示幅(px)。BboxPane が onDisplayWidth で通知。
  // フローティングウィジェットの横幅をこの幅に追従させ、PDF とウィジェットを中央で同幅に縦並びさせる。
  const [pdfDisplayWidth, setPdfDisplayWidth] = useState<number | null>(null)

  // フローティング nudge の配置用（選択 bbox の viewport 位置・§A3）。全層共通＝本体維持。
  // 記入欄 hook の applySnapshot / handleSplitSelected がリセットするため setter を hook へ渡す。
  const [selectionGeom, setSelectionGeom] = useState<SelectionGeom | null>(null)

  // fieldsVersion を hook の save から最新参照するための getter（依存配列を増やさず読む）。
  const fieldsVersionRef = useRef(fieldsVersion)
  fieldsVersionRef.current = fieldsVersion

  // 🚨 #18 後半: 保存後の背景キャッシュ固着対策。
  //   白塗り削除→保存で DB と image_cache PNG は最新化されるが、クライアントの背景 state
  //   （imageUrls/rawImageUrls）は古い signedUrl のまま → 記入欄/固定テキストモードに切替えても
  //   ブラウザが同一 src のロード済み画像をキャッシュ表示し「削除前の白塗りが焼き込まれた背景」が残る。
  //   保存成功時に bbox-editor GET を叩き直し、**背景 URL だけ**最新 signedUrl に差し替える。
  //   createSignedUrl は毎回別トークンを返すので src が変わり、ブラウザは確実に再取得する。
  //   編集 state（fields/whiteout/fixed）は保存済み＝既に最新なので上書きしない（選択等を保持）。
  const refetchBackgrounds = useCallback(async () => {
    try {
      const res = await fetch(`/api/templates/${templateId}/bbox-editor`, {
        cache: 'no-store',
      })
      if (!res.ok) return
      const data = await res.json()
      if (data.editable === false) return
      const init = data as InitialData
      // ブラウザ <img> キャッシュを確実に外すため、各 URL に保存時刻の cache-bust を付与。
      // 新 signedUrl だけでも src は変わるが、念のため二重で固着を断つ（src 変化＝再取得）。
      const bust = `_cb=${Date.now()}`
      const withBust = (u: string | null) =>
        u ? `${u}${u.includes('?') ? '&' : '?'}${bust}` : u
      setImageUrls(init.previewImageUrls.map(withBust))
      setRawImageUrls((init.rawPreviewImageUrls ?? []).map(withBust))
    } catch {
      // 背景の再取得失敗は致命ではない（次回入場で最新になる）。握りつぶす。
    }
  }, [templateId])

  // 記入欄レイヤの state/ref/handler/保存は useFieldLayerEditor に集約（§Phase7 S2）。
  // selectionGeom/fieldsVersion/errorMsg は全層共通で本体維持＝setter/getter を注入して橋渡しする。
  const field = useFieldLayerEditor({
    templateId,
    pageSizes,
    setSelectionGeom,
    getFieldsVersion: () => fieldsVersionRef.current,
    setFieldsVersion,
    setBodyErrorMsg: setErrorMsg,
  })
  // 本体 JSX / armedAt effect / 離脱ガードから参照する記入欄 state・handler を分配。
  const {
    fields,
    selectedName,
    setSelectedName,
    labelEditingName,
    splitEditing,
    dirty,
    saving,
    deleteToast,
  } = field

  // 白塗りレイヤの state/ref/handler は useWhiteoutLayer へ移送済み（Phase 7 S3）。
  // refetchBackgrounds / errorMsg は全層共通で本体維持 → setter を注入して橋渡しする。
  const whiteout = useWhiteoutLayer({
    pageSizes,
    templateId,
    refetchBackgrounds,
    setBodyErrorMsg: setErrorMsg,
  })
  const {
    fields: whiteoutFields,
    meta: whiteoutMeta,
    selectedName: whiteoutSelectedName,
    setSelectedName: setWhiteoutSelectedName,
    dirty: whiteoutDirty,
    saving: whiteoutSaving,
    canUndo: whiteoutCanUndo,
    canRedo: whiteoutCanRedo,
  } = whiteout

  // 固定テキストレイヤの state/ref/handler は useFixedLayer へ移送（Phase 7 S4）。
  // refetchBackgrounds / errorMsg は全層共通で本体維持 → setter を注入して橋渡しする。
  const fixed = useFixedLayer({
    pageSizes,
    templateId,
    refetchBackgrounds,
    setBodyErrorMsg: setErrorMsg,
  })
  const {
    fields: fixedFields,
    meta: fixedMeta,
    selectedName: fixedSelectedName,
    setSelectedName: setFixedSelectedName,
    dirty: fixedDirty,
    saving: fixedSaving,
    canUndo: fixedCanUndo,
    canRedo: fixedCanRedo,
  } = fixed

  // 🐛 実機FB: 最下部の枠を一回クリック（選択のつもり）しただけで縦分割が発火する。
  // 原因＝選択でフローティング nudge が出現し、最下部枠だと上へフリップしてクリック地点の
  // すぐ上に「縦に2分割」ボタンが来るため、pointerup 後の合成 click がボタンを直撃する。
  // 対策＝ウィジェット出現/再配置（選択 or geom 変化）直後の短時間に来た click を、破壊的
  // ボタン（分割/削除）だけ無視する。移動/リサイズ/nudge/追加/中央寄せ は無改変。
  const armedAtRef = useRef(0)
  useEffect(() => {
    // 選択切替・再配置のたびに保護開始時刻を更新。出現直後の合成 click を弾く。
    // 白塗りの選択切替も同様にガード（削除/却下トグルの誤爆防止）。
    armedAtRef.current = Date.now()
  }, [selectedName, whiteoutSelectedName, selectionGeom])
  const isFreshClick = useCallback(
    () => isWidgetEmergenceClick(Date.now(), armedAtRef.current, CLICK_GUARD_MS),
    [],
  )

  // ③ズーム（PY1-1・既定 1.0＝全体フィット）／④グリッド表示（PY1-4）。
  const [zoom, setZoom] = useState(1)
  const [showGrid, setShowGrid] = useState(false)

  // ②縦フィット基準高さ（PY1-5）。window 高から控除量を引く。SSR 安全に undefined 始点。
  const [viewportHeight, setViewportHeight] = useState<number | undefined>(undefined)
  useEffect(() => {
    const update = () =>
      setViewportHeight(
        Math.max(200, window.innerHeight - EDITOR_VIEWPORT_MARGIN_PX),
      )
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  const canvasRef = useRef<HTMLDivElement | null>(null)

  // whiteoutDirty は whiteout.dirty（hook 内 useMemo）を利用。
  // fixedDirty は fixed.dirty（hook 内 useMemo）を利用。

  // 追加UX-C（#19）: いずれかのモードに未保存があるか。「一覧へ」離脱ガードの発火条件。
  const anyDirty = dirty || whiteoutDirty || fixedDirty

  // 追加UX-C（#19）: 「一覧へ」離脱ガードのモーダル表示と一括保存中フラグ・失敗メッセージ。
  const [leaveGuardOpen, setLeaveGuardOpen] = useState(false)
  const [leaveSaving, setLeaveSaving] = useState(false)
  const [leaveSaveError, setLeaveSaveError] = useState<string | null>(null)

  // 初回ロード。
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/templates/${templateId}/bbox-editor`)
        if (!res.ok) {
          throw new Error(`load failed: ${res.status}`)
        }
        const data = await res.json()
        if (cancelled) return
        if (data.editable === false) {
          setUnsupportedReason(data.reason ?? null)
          setPhase('unsupported')
          return
        }
        const init = data as InitialData
        const efields: EditorField[] = init.fields.map((f) => ({
          name: f.name,
          label: f.label,
          bbox: f.bbox,
        }))
        setPageSizes(init.pageSizes)
        setImageUrls(init.previewImageUrls)
        // ②動的プレビュー: raw 背景が来ていれば白塗り canvas に使う。無ければ焼込済を流用。
        setRawImageUrls(init.rawPreviewImageUrls ?? [])
        // 記入欄レイヤの初期化は hook へ集約（fields/snapshot 確定＋履歴・採番集合・選択リセット）。
        field.init(efields, JSON.stringify(efields))
        setFieldsVersion(init.fieldsVersion)
        // 段階2 Phase 2-C（§2-1）: 白塗りを EditorField＋meta に詰め替えて初期化。
        // hook の init を呼ぶ（fields/snapshot 確定＋履歴クリア・選択リセット）。
        const { fields: woFields, meta: woMeta } = whiteoutBoxesToFields(
          init.whiteoutBoxes ?? [],
        )
        whiteout.init(woFields, woMeta)
        // 段階2 C-2（§3-1）: 固定テキストを EditorField＋meta に詰め替えて初期化（hook へ委譲）。
        const { fields: ftFields, meta: ftMeta } = fixedTextsToFields(
          init.fixedTexts ?? [],
        )
        fixed.init(ftFields, ftMeta)
        setPhase('ready')
      } catch (e) {
        if (cancelled) return
        setErrorMsg(e instanceof Error ? e.message : String(e))
        setPhase('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [templateId])

  // 離脱警告（未保存時のみ。記入欄/白塗り/固定テキストいずれかに未保存があれば警告）。
  useEffect(() => {
    if (!dirty && !whiteoutDirty && !fixedDirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty, whiteoutDirty, fixedDirty])

  // 各レイヤの state/ref/handler は useFieldLayerEditor / useWhiteoutLayer / useFixedLayer へ移送済み。
  // 本体 JSX は field.* / whiteout.* / fixed.* を参照する。

  // ── 追加UX-C（#19）: 「一覧へ」離脱時の未保存セーフガード ──────────────────────
  //
  // 「一覧へ」押下時に未保存（anyDirty）があればモーダルを出す。無ければ即遷移。
  // データ損失防止が目的なので、保存=全モード未保存を順次保存→遷移、破棄=保存せず遷移、
  // キャンセル=留まる、の 3 択にする。

  // 🚨 #19 差し戻し対応: 下記 3 ハンドラは useCallback にしない（通常関数）。
  //   useCallback でメモ化すると古いクロージャを握り、最新 state が保存されないバグになる。
  //   毎レンダ生成の素の関数なら、クリック時点の最新 state/handler を必ず参照する（race なし）。

  /** 「一覧へ」クリック。未保存があればモーダル、無ければ即遷移（router.push）。 */
  function handleBackClick() {
    if (anyDirty) {
      setLeaveSaveError(null)
      setLeaveGuardOpen(true)
      return
    }
    router.push(backHref)
  }

  /**
   * モーダル「保存して移動」。dirty なモードだけ順次 await 保存（白塗りは 500/再焼き込みを含む）。
   * 全成功で一覧へ遷移。1 つでも失敗したらモーダルに留まり失敗を表示（エディタは保持）。
   * 各 save handler は DB 反映完了まで await してから次へ進む（router.push 前に必ず全 await 完了）。
   */
  async function handleLeaveSaveAll() {
    setLeaveSaving(true)
    setLeaveSaveError(null)
    // 記入欄 → 白塗り → 固定テキスト の順。dirty なモードだけ順次 await（runLeaveSaves・テスト可能）。
    const failed = await runLeaveSaves([
      { dirty, label: '記入欄', save: field.save },
      { dirty: whiteoutDirty, label: '白塗り', save: whiteout.save },
      { dirty: fixedDirty, label: '固定テキスト', save: fixed.save },
    ])
    setLeaveSaving(false)
    if (failed.length > 0) {
      // 部分失敗: モーダルに留まり、失敗モードを告知（エディタの編集内容は保持）。
      setLeaveSaveError(`${failed.join('・')}の保存に失敗しました。時間をおいて再度お試しください。`)
      return
    }
    setLeaveGuardOpen(false)
    router.push(backHref)
  }

  /** モーダル「保存せず移動」。未保存を破棄して一覧へ遷移。 */
  function handleLeaveDiscard() {
    setLeaveGuardOpen(false)
    router.push(backHref)
  }

  // 追加UX-C（#19）: 「← 一覧へ」リンク（page.tsx から client へ移設）。全 phase 共通で出す。
  // ready 以外は未保存が無いので handleBackClick は即遷移する（anyDirty=false）。
  const backLink = (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={handleBackClick}
        className="text-sm text-gizirotto-blue-700 hover:underline"
      >
        ← 一覧へ
      </button>
    </div>
  )

  if (phase === 'loading') {
    return (
      <div className="space-y-3">
        {backLink}
        <p className="text-sm text-gray-600">読み込んでいます…</p>
      </div>
    )
  }

  if (phase === 'unsupported') {
    return (
      <div className="space-y-3">
        {backLink}
        <div className="text-sm text-gray-700 bg-gizirotto-blue-50 border border-gizirotto-blue-100 rounded p-4">
          このテンプレは位置調整に対応していません。
          <span className="block text-xs text-gray-500 mt-1">
            位置調整は PDF から作成したテンプレートでのみご利用いただけます。
          </span>
        </div>
      </div>
    )
  }

  if (phase === 'error') {
    // 本コンポーネントはモーダルでなくページ内インライン表示なので、ページのナビ/戻るは常に使える
    // （＝詰まない）。加えてエラーから自力回復できるよう再読み込み導線を 1 つ置く（UX のみ・ロジック無改変）。
    return (
      <div className="space-y-3">
        {backLink}
        <ErrorNotice code={errorMsg} prefix="読み込みに失敗しました" />
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="bg-white border border-gizirotto-blue-500 text-gizirotto-blue-700 hover:bg-gizirotto-blue-500/10 font-medium px-4 py-2 rounded text-sm"
        >
          再読み込み
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* 追加UX-C（#19）: 「← 一覧へ」。未保存があれば離脱ガードのモーダルを出す（押下=handleBackClick）。 */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleBackClick}
          className="text-sm text-gizirotto-blue-700 hover:underline"
        >
          ← 一覧へ
        </button>
      </div>

      {/* 段階2 Phase 2-C（§4-1）: 記入欄/白塗りのモード切替トグル（同一画面・レイヤ切替）。
          切替で選択は解除（モード跨ぎの選択誤爆を防ぐ）。背景は両モード共用＝再ロードなし。 */}
      <div className="inline-flex rounded-lg border border-gray-300 bg-gray-100 p-0.5">
        {(['field', 'whiteout', 'fixed'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMode(m)
              setSelectedName(null)
              setWhiteoutSelectedName(null)
              setFixedSelectedName(null)
            }}
            aria-pressed={mode === m}
            className={
              'px-4 py-2 text-sm font-medium rounded-md transition-colors ' +
              (mode === m
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

      {/* #20 実機FB（task #6）: PC幅で 3モードのボタン列配置を「記入欄＝右側横並び」に統一する。
          原因＝3モードのヘッダー構造は元から共通（同一 flex 行に 説明文<p>｜ボタン列<div>）だが、
          説明文 <p> の長さがモードで違い（記入欄=短文／白塗り・固定=長文）、親が flex-wrap のため
          長文モードだけボタン列が次行（左寄せ）へ折り返していた。
          対策（PC幅 sm 以上で確実に同一行・右寄せ）:
            - 親に sm:flex-nowrap を付け、PC幅では折り返し自体を禁止（長文でも1行を維持）。
            - 説明文 <p> に sm:flex-1 sm:min-w-0 を付け、長文時は <p> 側だけが縮む（truncate なし＝
              そのまま折り返し表示でOK・縦に伸びるだけ）。ボタン列は sm:shrink-0 で縮まず右寄せ固定。
          sm 未満（スマホ）は flex-wrap のまま＝従来のモバイル挙動を完全維持（下部バー/右パネルは別系統）。 */}
      <div className="flex items-center justify-between gap-3 flex-wrap sm:flex-nowrap">
        <p className="text-sm text-gray-600 sm:flex-1 sm:min-w-0">
          {mode === 'whiteout'
            ? '白塗りの枠を選んでドラッグ、または下のボタン・矢印キーで 1px ずつ調整できます。記入欄は薄く参考表示しています。'
            : mode === 'fixed'
              ? '固定テキストの枠を選んで値を入力し、ドラッグや矢印キーで位置を調整できます。会議名・参加者など常に同じ文字を配置できます。'
              : '枠を選んでドラッグ、または下のボタン・矢印キーで 1px ずつ調整できます。'}
        </p>
        <div className="flex items-center gap-3 sm:shrink-0">
          {/* 実機FB: 「未保存の変更があります」バッジは横並びから外し、各モードの「保存する」ボタンの
              **真上**に小さく出すだけにする（バッジ有無で他ボタン＝グリッド/戻る/進む/枠を追加/保存 の
              位置がズレないように・下の relative ラッパ内 absolute で配置）。 */}
          {/* ④グリッド/中心線トグル（PY1-4・Q-Y6・実機FB）。両モード共通。 */}
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

          {mode === 'field' ? (
            <>
              {/* #20 全モードUI統一: 戻る/進む（記入欄スタック）。配置は 3 モード共通。 */}
              <UndoRedoButtons
                onUndo={field.handleUndo}
                onRedo={field.handleRedo}
                canUndo={field.canUndo}
                canRedo={field.canRedo}
              />
              {/* グループB B-3（§2-1/§2-5）: 「枠を追加」。20 個で disabled＋ツールチップ。 */}
              <button
                type="button"
                onClick={field.handleAddField}
                disabled={fields.length >= FIELDS_MAX}
                title={fields.length >= FIELDS_MAX ? '枠は20個までです' : undefined}
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
                    saving ||
                    !dirty ||
                    splitEditing !== null ||
                    labelEditingName !== null
                  }
                  className="bg-gizirotto-blue-500 hover:bg-gizirotto-blue-700 text-white font-medium px-3 py-2 rounded text-sm disabled:opacity-50"
                >
                  {saving ? '保存中…' : '保存'}
                </button>
              </div>
            </>
          ) : mode === 'whiteout' ? (
            <>
              {/* 戻る/進む（白塗りスタック）。配置は記入欄と同一順。 */}
              <UndoRedoButtons
                onUndo={whiteout.undo}
                onRedo={whiteout.redo}
                canUndo={whiteoutCanUndo}
                canRedo={whiteoutCanRedo}
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
                  disabled={whiteoutSaving || !whiteoutDirty}
                  className="bg-gray-700 hover:bg-gray-900 text-white font-medium px-3 py-2 rounded text-sm disabled:opacity-50"
                >
                  {whiteoutSaving ? '保存中…' : '保存'}
                </button>
              </div>
            </>
          ) : (
            <>
              {/* #20 全モードUI統一: 戻る/進む（固定テキスト独立スタック）。配置は記入欄と同一順。 */}
              <UndoRedoButtons
                onUndo={fixed.undo}
                onRedo={fixed.redo}
                canUndo={fixedCanUndo}
                canRedo={fixedCanRedo}
              />
              {/* 固定テキストを追加（C-2 §3-2）。生成後に右パネルで value を入力。 */}
              <button
                type="button"
                onClick={fixed.addBox}
                className="bg-white border border-gizirotto-blue-500 text-gizirotto-blue-700 hover:bg-gizirotto-blue-500/10 font-medium px-3 py-2 rounded text-sm"
              >
                固定テキストを追加
              </button>
              {/* 固定テキスト保存（C-2 §3-6）: fixed_texts カラムのみ更新（fields/fieldsVersion 非発火）。
                  保存ボタンは現行方式（未保存バッジ無し・dirty で活性／非dirty で opacity-50）。 */}
              <div className="relative">
                <button
                  type="button"
                  onClick={fixed.save}
                  disabled={fixedSaving || !fixedDirty}
                  className="bg-gizirotto-blue-500 hover:bg-gizirotto-blue-700 text-white font-medium px-3 py-2 rounded text-sm disabled:opacity-50"
                >
                  {fixedSaving ? '保存中…' : '保存'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {errorMsg && <ErrorNotice code={errorMsg} prefix="保存できませんでした" />}

      {/* レイアウト2分岐（実機FB 再修正）: md(768px) 以上は 2 カラム＝左 PDF / 右 固定操作パネル。
          md 未満（スマホ）は単カラム＋下部中央バー。
          起点は md(768px)。640px(sm) では右パネル 320px を引くと PDF が ~300px と窮屈で
          プレビューが読めないため、640〜768px のタブレットも 2 カラム化せず md 起点に揃えた
          （実機検証メモ。sm 起点に下げたい場合は md→sm に一括置換すれば 640px から効く）。 */}
      <div className="md:grid md:grid-cols-[minmax(0,1fr)_320px] md:gap-4 md:items-start">
      {/* キャンバス: tabIndex でフォーカスを受け keydown を拾う（§2-3）。
          実機FB①: bbox 以外（テンプレ外の水色背景=エディタ領域外含む）どこをクリックしても
          選択解除＝ウィジェットが閉じるよう、エディタ全体で bbox 外クリックを検知する。
          bbox 要素は data-box を持ち startMove/startResize で stopPropagation するため、
          ここに届くのは bbox 外クリックのみ（保険で closest('[data-box]') も判定）。
          スマホ: 下部フローティングウィジェットと被って PDF 下辺が編集不可になるのを防ぐため
          pb で余白を確保し、PDF 下辺がウィジェット上端まで来るまでスクロールできるようにする（実機FB）。
          md 以上は右パネル＝フローティング無しなので余白不要（md:pb-0）。 */}
      <div
        ref={canvasRef}
        tabIndex={0}
        onKeyDown={
          mode === 'whiteout'
            ? whiteout.onKeyDown
            : mode === 'fixed'
              ? fixed.onKeyDown
              : field.onKeyDown
        }
        onPointerDown={(e) => {
          if (!(e.target as HTMLElement).closest('[data-box]')) {
            // bbox 外クリックで現在モードの選択を解除（ウィジェットを閉じる）。
            if (mode === 'whiteout') setWhiteoutSelectedName(null)
            else if (mode === 'fixed') setFixedSelectedName(null)
            else setSelectedName(null)
          }
        }}
        className="space-y-6 outline-none focus:ring-2 focus:ring-gizirotto-blue-300 rounded pb-[60vh] md:pb-0"
      >
        {pageSizes.map((meta) => {
          const pageFields = fields.filter((f) => f.bbox.page === meta.page)
          const pageWhiteout = whiteoutFields.filter(
            (f) => f.bbox.page === meta.page,
          )
          const pageFixed = fixedFields.filter((f) => f.bbox.page === meta.page)
          // 段階2 Phase 2-C/2-D（§4-1 + 実機FB）: モードで編集対象を切替。背景PNGは両モード共用＝1ロード。
          // 2-D 修正: もう片方の薄い参考表示（reference）は廃止＝そのモードの枠だけを出す（実機検証判断）。
          //
          // #17（v1.8 §3-3-2）: raw 背景を全モードに渡し、canvas で「白塗り + 固定テキスト」を動的合成。
          //   bbox-editor 背景への固定テキスト焼き込み（v1.6.3 #15）は撤回（二重表示 + 再編集不可バグ）。
          //   - 白塗りモード: 編集中 fields を boxes 化（既存・削除で透ける UX 維持）＋ 固定テキストは
          //     DB/編集状態の全量を canvas 重ね描画。
          //   - 固定/記入欄モード: dynamicWhiteoutBoxes = DB 保存白塗り、dynamicFixedTexts = 編集中
          //     固定テキスト（fixedFields+fixedMeta から都度組み立て＝編集即反映）。
          const rawUrl = rawImageUrls[meta.page - 1] ?? null
          const allFixedTexts = fieldsToFixedTexts(fixedFields, fixedMeta)
          const allWhiteoutBoxes = fieldsToWhiteoutBoxes(whiteoutFields, whiteoutMeta)
          if (mode === 'whiteout') {
            return (
              <BboxPane
                key={meta.page}
                meta={meta}
                imageUrl={imageUrls[meta.page - 1] ?? null}
                whiteoutRawImageUrl={rawUrl}
                whiteoutBgColorOf={whiteout.bgColorOf}
                fields={pageWhiteout}
                selectedName={whiteoutSelectedName}
                onSelect={setWhiteoutSelectedName}
                onChangeBbox={whiteout.applyBbox}
                onDragStart={whiteout.onDragStart}
                onDragCommit={whiteout.onDragCommit}
                onSelectionGeom={setSelectionGeom}
                zoom={zoom}
                viewportHeight={viewportHeight}
                showGrid={showGrid}
                variant="whiteout"
                whiteoutKindOf={whiteout.kindOf}
                onDisplayWidth={setPdfDisplayWidth}
                dynamicFixedTexts={allFixedTexts}
              />
            )
          }
          if (mode === 'fixed') {
            // 固定テキストモード: bbox-pane を共用（whiteout モード流用＝矩形ドラッグ/選択/nudge）。
            // 見た目は記入欄と同じ青枠（variant 既定 'field'）＝値ありの枠なので青で判別しやすい。
            return (
              <BboxPane
                key={meta.page}
                meta={meta}
                imageUrl={imageUrls[meta.page - 1] ?? null}
                whiteoutRawImageUrl={rawUrl}
                fields={pageFixed}
                selectedName={fixedSelectedName}
                onSelect={setFixedSelectedName}
                onChangeBbox={fixed.applyBbox}
                onDragStart={fixed.onDragStart}
                onDragCommit={fixed.onDragCommit}
                onSelectionGeom={setSelectionGeom}
                zoom={zoom}
                viewportHeight={viewportHeight}
                showGrid={showGrid}
                onDisplayWidth={setPdfDisplayWidth}
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
              imageUrl={imageUrls[meta.page - 1] ?? null}
              whiteoutRawImageUrl={rawUrl}
              fields={pageFields}
              selectedName={selectedName}
              onSelect={setSelectedName}
              onChangeBbox={field.applyBbox}
              onDragStart={field.handleFieldDragStart}
              onDragCommit={field.handleFieldDragCommit}
              onSelectionGeom={setSelectionGeom}
              zoom={zoom}
              viewportHeight={viewportHeight}
              showGrid={showGrid}
              onDisplayWidth={setPdfDisplayWidth}
              dynamicWhiteoutBoxes={allWhiteoutBoxes}
              dynamicFixedTexts={allFixedTexts}
            />
          )
        })}
      </div>

      {/* md(768px) 以上の右固定パネル（実機FB 再修正・案A）: フローティングをやめ常設パネルで操作。
          選択中 bbox の操作をここで行い、未選択時はプレースホルダを出す。md 未満（スマホ）は非表示。 */}
      <aside className="hidden md:block md:sticky md:top-4 self-start">
        <div className="bg-white border border-gray-200 rounded-lg px-3 py-3 shadow-sm">
          {mode === 'field' ? (
            (() => {
              const sel = fields.find((f) => f.name === selectedName)
              if (!selectedName || !sel) {
                return (
                  <p className="text-sm text-gray-500 py-8 text-center">
                    枠を選んでください
                  </p>
                )
              }
              const canSplit =
                fields.length < FIELDS_MAX && sel.bbox.w / 2 >= MIN_BBOX_PT
              const splitDisabledReason =
                fields.length >= FIELDS_MAX
                  ? '分割すると枠が20個を超えます'
                  : sel.bbox.w / 2 < MIN_BBOX_PT
                    ? '枠が小さすぎて分割できません'
                    : undefined
              return (
                <FieldControlsBody
                  onNudge={field.applyNudge}
                  onCenter={field.applyCenter}
                  onDelete={field.handleDeleteSelected}
                  canDelete={fields.length > 1}
                  onSplit={field.handleSplitSelected}
                  canSplit={canSplit}
                  splitDisabledReason={splitDisabledReason}
                  labelEditing={labelEditingName === selectedName}
                  labelValue={sel.label ?? ''}
                  onLabelChange={(v) => field.handleLabelChange(selectedName, v)}
                  onLabelCommit={field.handleLabelCommit}
                  onStartRename={field.handleStartRenameLabel}
                  isFreshClick={isFreshClick}
                  compact
                />
              )
            })()
          ) : mode === 'whiteout' ? (() => {
            const sel = whiteoutSelectedName
              ? whiteoutFields.find((f) => f.name === whiteoutSelectedName)
              : undefined
            if (!whiteoutSelectedName || !sel) {
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
            const sel = fixedSelectedName
              ? fixedFields.find((f) => f.name === fixedSelectedName)
              : undefined
            if (!fixedSelectedName || !sel) {
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
                value={fixedMeta.get(fixedSelectedName)?.value ?? ''}
                onValueChange={(v) => fixed.fixedValueChange(fixedSelectedName, v)}
                compact
              />
            )
          })()}
        </div>
      </aside>
      </div>

      {/* 白塗りモードのフローティング nudge（§5-2）: 移動/中央寄せ/削除（採用却下トグルは廃止・削除に統一）。
          命名パネル・分割は出さない（§4-3 / Q-α3 分割なし）。
          md 未満（スマホ）=PDF幅追従の下部中央バー（幅追従スケール）。
          md 以上（タブレット＋PC）は右パネルへ集約＝フローティング自体が消える（FloatingShell）。 */}
      {mode === 'whiteout' && whiteoutSelectedName && (() => {
        const sel = whiteoutFields.find((f) => f.name === whiteoutSelectedName)
        return (
          <WhiteoutFloatingNudge
            onNudge={whiteout.applyNudge}
            onCenter={whiteout.applyCenter}
            onDelete={whiteout.deleteSelected}
            pdfWidth={pdfDisplayWidth}
            key={sel?.name}
          />
        )
      })()}

      {/* 固定テキストモードのフローティング nudge（C-2 §3-2）: 値入力＋移動/中央寄せ/削除。
          md 未満（スマホ）=PDF幅追従の下部中央バー。md 以上は右パネルへ集約＝フローティング消える。 */}
      {mode === 'fixed' && fixedSelectedName && (() => {
        const sel = fixedFields.find((f) => f.name === fixedSelectedName)
        return (
          <FixedTextFloatingNudge
            onNudge={fixed.applyNudge}
            onCenter={fixed.applyCenter}
            onDelete={fixed.deleteSelected}
            onSizeStep={fixed.fixedSizeStep}
            value={fixedMeta.get(fixedSelectedName)?.value ?? ''}
            onValueChange={(v) => fixed.fixedValueChange(fixedSelectedName, v)}
            pdfWidth={pdfDisplayWidth}
            key={sel?.name}
          />
        )
      })()}

      {/* フローティング nudge（§A3）: 選択中のみ表示。
          md 未満（スマホ）=PDF幅追従の下部中央バー（幅追従スケールで3カラム維持）／
          md 以上（タブレット＋PC）=右固定パネル。 */}
      {mode === 'field' && selectedName && (() => {
        const sel = fields.find((f) => f.name === selectedName)
        // B-4 分割可否: 件数 19 未満（+1 で 20 以内）かつ半分が最小幅以上。
        const canSplit =
          !!sel &&
          fields.length < FIELDS_MAX &&
          sel.bbox.w / 2 >= MIN_BBOX_PT
        // disabled 理由（ツールチップ）: 件数優先、次に最小幅。
        const splitDisabledReason =
          sel && fields.length >= FIELDS_MAX
            ? '分割すると枠が20個を超えます'
            : sel && sel.bbox.w / 2 < MIN_BBOX_PT
              ? '枠が小さすぎて分割できません'
              : undefined
        return (
          <FloatingNudge
            onNudge={field.applyNudge}
            onCenter={field.applyCenter}
            onDelete={field.handleDeleteSelected}
            canDelete={fields.length > 1}
            onSplit={field.handleSplitSelected}
            canSplit={canSplit}
            splitDisabledReason={splitDisabledReason}
            labelEditing={labelEditingName === selectedName}
            labelValue={sel?.label ?? ''}
            onLabelChange={(v) => field.handleLabelChange(selectedName, v)}
            onLabelCommit={field.handleLabelCommit}
            onStartRename={field.handleStartRenameLabel}
            isFreshClick={isFreshClick}
            pdfWidth={pdfDisplayWidth}
          />
        )
      })()}

      {/* グループB B-4（§3-3）: 分割直後の 2 枠同時命名パネル。
          左右それぞれに label 入力欄を出し、元 label をプレースホルダ参考表示する。
          区切り文字での機械自動分割はしない（$0・誤分割防止）。確定で両未入力は項目N仮置き。 */}
      {splitEditing && (
        <SplitNamingPanel
          leftValue={
            fields.find((f) => f.name === splitEditing.leftName)?.label ?? ''
          }
          rightValue={
            fields.find((f) => f.name === splitEditing.rightName)?.label ?? ''
          }
          origLabel={splitEditing.origLabel}
          onLeftChange={(v) => field.handleSplitLabelChange(splitEditing.leftName, v)}
          onRightChange={(v) => field.handleSplitLabelChange(splitEditing.rightName, v)}
          onCommit={field.handleSplitCommit}
        />
      )}

      {/* 削除 告知トースト（§4 案A）: 削除直後に一定時間表示。「元に戻す」=汎用 handleUndo を呼ぶ。
          トーストが消えても undoStack は残る＝8秒過ぎても ↩/Ctrl+Z で戻せる（旧8秒制約の改善）。
          スマホ下部 nudge バー（bottom-0）と被らないよう bottom を上げる。 */}
      {deleteToast && (
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

      {/* ③ズームパネル（Q-Y4・右下固定）。🔍/[−]/スライダー/[+]/倍率%。 */}
      <ZoomPanel zoom={zoom} onZoom={setZoom} />

      {/* 追加UX-C（#19）: 「一覧へ」離脱時の未保存セーフガード・モーダル。
          データ損失防止＝保存して移動 / 保存せず移動 / キャンセル の 3 択。
          共通モーダル化により Esc / 初期 focus / 背景クリック閉じが自動付与（a11y 副次改善）。 */}
      <UnsavedChangesModal
        open={leaveGuardOpen}
        description="一覧へ戻る前に、編集した内容を保存しますか？"
        onSave={handleLeaveSaveAll}
        onDiscard={handleLeaveDiscard}
        onCancel={() => setLeaveGuardOpen(false)}
        saving={leaveSaving}
        error={leaveSaveError}
      />
    </div>
  )
}
