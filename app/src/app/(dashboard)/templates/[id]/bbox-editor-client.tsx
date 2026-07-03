'use client'

/**
 * bbox エディタ クライアント本体。
 *
 * 責務:
 *   - GET /api/templates/[id]/bbox-editor で初期データ取得（背景/pageSizes/fields/version）
 *   - 選択状態（selectedName）・編集中 fields（pt 空間・丸めなし）の state 管理
 *   - 「変更あり」表示（初期スナップショットとの差分）＋ beforeunload 離脱警告
 *   - キーボード矢印（移動）/ Shift+矢印（リサイズ）＋ nudge ボタン（移動 4・サイズ 4）
 *   - 明示「保存」ボタンのみ DB 更新（操作中 DB 不変）。楽観ロック CONFLICT を擬人化表示。
 *   - Q8 フォールバック（editable:false）= 「このテンプレは位置調整に対応していません」
 *
 * 1px = 元画像 px 基準（stepPt）。pt の加減算で ±4px を保証。
 *
 * データ集約 + phase 早期return までを本体（Container）が担い、ready 時の JSX は
 * BboxEditorView（Presenter）へ委譲する。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  type PageMeta,
  type BboxPt,
  isWidgetEmergenceClick,
  CLICK_GUARD_MS,
} from '@/lib/pdf-output/bbox-coords'
import { useFieldLayerEditor } from '@/hooks/editor/useFieldLayerEditor'
import { useWhiteoutLayer } from '@/hooks/editor/useWhiteoutLayer'
import { useFixedLayer } from '@/hooks/editor/useFixedLayer'
import ErrorNotice from '@/components/error-notice'
import type { EditorField, SelectionGeom } from './bbox-pane'
import {
  whiteoutBoxesToFields,
  type WhiteoutBoxInput,
} from '@/lib/pdf-output/whiteout-adapter'
import {
  fixedTextsToFields,
  type FixedText,
} from '@/lib/pdf-output/fixedtext-adapter'
import { type EditMode } from './_components/editor-types'
import BboxEditorView from './_components/BboxEditorView'

interface InitialData {
  fields: Array<{ name: string; label: string; bbox: BboxPt & { page: number } }>
  pageSizes: PageMeta[]
  previewImageUrls: (string | null)[]
  /**
   * 白塗りモードの canvas 用 raw 背景（合成なし）。
   * null（raw 非対応テンプレ）は previewImageUrls へフォールバック。
   */
  rawPreviewImageUrls?: (string | null)[] | null
  fieldsVersion: string
  /** 白塗り編集モードの編集対象（左上原点pt・記入欄と同一座標系）。 */
  whiteoutBoxes?: WhiteoutBoxInput[]
  /** 固定テキスト編集モードの編集対象（左上原点pt・記入欄と同一座標系）。 */
  fixedTexts?: FixedText[]
}

type Phase = 'loading' | 'ready' | 'unsupported' | 'error'

/** 一覧離脱ガードの保存対象 1 モード（dirty 判定・ラベル・save 実行関数）。 */
export interface LeaveSaveTask {
  /** dirty なら保存対象。false のモードはスキップ。 */
  dirty: boolean
  /** 失敗告知に出す日本語ラベル（例: 記入欄 / 白塗り / 固定テキスト）。 */
  label: string
  /** その モードの保存。成功 true・失敗 false を返す（DB 反映まで await 済み）。 */
  save: () => Promise<boolean>
}

/**
 * 「保存して移動」の一括保存。dirty なモードだけを**順次 await** で保存し、
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
 * フローティングウィジェットが等倍（scale=1）で 3カラム
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
  readOnly = false,
}: {
  templateId: string
  /** 「一覧へ」戻り先（未保存ガード経由で遷移する）。 */
  backHref?: string
  /** true のとき保存・追加・削除等の変更操作 UI を非表示にし閲覧専用にする。 */
  readOnly?: boolean
}) {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('loading')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [unsupportedReason, setUnsupportedReason] = useState<string | null>(null)

  const [pageSizes, setPageSizes] = useState<PageMeta[]>([])
  const [imageUrls, setImageUrls] = useState<(string | null)[]>([])
  // 白塗りモードの canvas 用 raw 背景。null は焼込済へフォールバック。
  const [rawImageUrls, setRawImageUrls] = useState<(string | null)[]>([])
  // fieldsVersion は記入欄保存の楽観ロックに使う（全層共有 state なので本体維持・hook へ getter/setter 注入）。
  const [fieldsVersion, setFieldsVersion] = useState<string>('')

  // 編集モード（記入欄 / 白塗り / 固定テキスト）。既定は記入欄＝従来挙動。
  const [mode, setMode] = useState<EditMode>('field')

  // PDF プレビューの実表示幅(px)。BboxPane が onDisplayWidth で通知。
  // フローティングウィジェットの横幅をこの幅に追従させ、PDF とウィジェットを中央で同幅に縦並びさせる。
  const [pdfDisplayWidth, setPdfDisplayWidth] = useState<number | null>(null)

  // フローティング nudge の配置用（選択 bbox の viewport 位置）。全層共通＝本体維持。
  // 記入欄 hook の applySnapshot / handleSplitSelected がリセットするため setter を hook へ渡す。
  const [selectionGeom, setSelectionGeom] = useState<SelectionGeom | null>(null)

  // fieldsVersion を hook の save から最新参照するための getter（依存配列を増やさず読む）。
  const fieldsVersionRef = useRef(fieldsVersion)
  fieldsVersionRef.current = fieldsVersion

  // 保存後の背景キャッシュ固着対策。
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

  // 記入欄レイヤの state/ref/handler/保存は useFieldLayerEditor に集約。
  // selectionGeom/fieldsVersion/errorMsg は全層共通で本体維持＝setter/getter を注入して橋渡しする。
  const field = useFieldLayerEditor({
    templateId,
    pageSizes,
    setSelectionGeom,
    getFieldsVersion: () => fieldsVersionRef.current,
    setFieldsVersion,
    setBodyErrorMsg: setErrorMsg,
  })
  const { selectedName, dirty } = field

  // 白塗りレイヤの state/ref/handler は useWhiteoutLayer へ移送済み。
  // refetchBackgrounds / errorMsg は全層共通で本体維持 → setter を注入して橋渡しする。
  const whiteout = useWhiteoutLayer({
    pageSizes,
    templateId,
    refetchBackgrounds,
    setBodyErrorMsg: setErrorMsg,
  })
  const { selectedName: whiteoutSelectedName, dirty: whiteoutDirty } = whiteout

  // 固定テキストレイヤの state/ref/handler は useFixedLayer へ移送済み。
  // refetchBackgrounds / errorMsg は全層共通で本体維持 → setter を注入して橋渡しする。
  const fixed = useFixedLayer({
    pageSizes,
    templateId,
    refetchBackgrounds,
    setBodyErrorMsg: setErrorMsg,
  })
  const { dirty: fixedDirty } = fixed

  // 最下部の枠を一回クリック（選択のつもり）しただけで縦分割が発火する問題の対策。
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

  // いずれかのモードに未保存があるか。「一覧へ」離脱ガードの発火条件。
  const anyDirty = dirty || whiteoutDirty || fixedDirty

  // 「一覧へ」離脱ガードのモーダル表示と一括保存中フラグ・失敗メッセージ。
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
        // 白塗りを EditorField＋meta に詰め替えて初期化。
        // hook の init を呼ぶ（fields/snapshot 確定＋履歴クリア・選択リセット）。
        const { fields: woFields, meta: woMeta } = whiteoutBoxesToFields(
          init.whiteoutBoxes ?? [],
        )
        whiteout.init(woFields, woMeta)
        // 固定テキストを EditorField＋meta に詰め替えて初期化（hook へ委譲）。
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
  // BboxEditorView（Presenter）は field.* / whiteout.* / fixed.* を参照する。

  // 「一覧へ」押下時に未保存（anyDirty）があればモーダルを出す。無ければ即遷移。
  // データ損失防止が目的なので、保存=全モード未保存を順次保存→遷移、破棄=保存せず遷移、
  // キャンセル=留まる、の 3 択にする。

  // 下記 3 ハンドラは useCallback にしない（通常関数）。
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

  /** モード切替（記入欄/白塗り/固定テキスト）。切替時は 3 モード全ての選択を解除する。 */
  function handleModeChange(m: EditMode) {
    setMode(m)
    field.setSelectedName(null)
    whiteout.setSelectedName(null)
    fixed.setSelectedName(null)
  }

  // 「← 一覧へ」リンク。全 phase 共通で出す。
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
    <BboxEditorView
      field={field}
      whiteout={whiteout}
      fixed={fixed}
      view={{
        mode,
        onModeChange: handleModeChange,
        zoom,
        onZoom: setZoom,
        showGrid,
        onToggleGrid: () => setShowGrid((v) => !v),
        viewportHeight,
        pdfDisplayWidth,
        onDisplayWidth: setPdfDisplayWidth,
        readOnly,
      }}
      data={{
        pageSizes,
        imageUrls,
        rawImageUrls,
        selectionGeom,
        setSelectionGeom,
      }}
      onBackClick={handleBackClick}
      canvasRef={canvasRef}
      isFreshClick={isFreshClick}
      errorMsg={errorMsg}
      leaveGuard={{
        open: leaveGuardOpen,
        saving: leaveSaving,
        error: leaveSaveError,
        onSave: handleLeaveSaveAll,
        onDiscard: handleLeaveDiscard,
        onCancel: () => setLeaveGuardOpen(false),
      }}
    />
  )
}
