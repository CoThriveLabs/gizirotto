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
  type PageMeta,
  type BboxPt,
  type ResizeCorner,
  type FitOptions,
  displayWidth,
  displayHeight,
  ptToDispX,
  ptToDispY,
  dispToPtX,
  dispToPtY,
  moveBbox,
  resizeBbox,
  resizeBboxKeepAspect,
  clampResizeToPage,
} from '@/lib/pdf-output/bbox-coords'
import {
  type BboxVariant,
  type WhiteoutKind,
  bboxBoxClass,
  bboxHandleClass,
  bboxLabelClass,
} from './bbox-variant'
import { FIXED_TEXT_FONT_SIZE_RATIO } from '@/lib/pdf-output/fixedtext-adapter'
import type { FixedText } from '@/lib/pdf-output/fixedtext-adapter'
import { compositeWhiteoutOnCanvas } from '@/lib/preview/whiteout-composite-canvas'
import { compositeFixedTextsOnCanvas } from '@/lib/preview/fixedtext-composite-canvas'
import {
  compositeFieldValuesOnCanvas,
  type FieldValueComposite,
} from '@/lib/preview/field-values-composite-canvas'
// ドラッグ中の軽量レイヤ描画ヘルパ（pure）。
import { paintDraggingField } from '@/lib/preview/drag-overlay-canvas'
import type { FittableFont } from '@/lib/pdf-output/fitting'
import type {
  WhiteoutBox,
  RgbColor,
} from '@/lib/parsers/pdf/whiteout-pipeline'

export interface EditorField {
  name: string
  label: string
  bbox: BboxPt & { page: number }
}

/** 選択中 bbox の画面位置（フローティング nudge の近傍配置用・§A3）。 */
export interface SelectionGeom {
  /** ビューポート基準（fixed/PC 近傍配置に使う）。 */
  viewportLeft: number
  viewportTop: number
  width: number
  height: number
}

interface Props {
  meta: PageMeta
  imageUrl: string | null
  /** このページに属する field のみ。 */
  fields: EditorField[]
  selectedName: string | null
  /** name 選択。null で選択解除（空白クリック・§A3）。 */
  onSelect: (name: string | null) => void
  /** bbox 更新（移動/リサイズの結果。pt 空間、丸めなし）。 */
  onChangeBbox: (name: string, bbox: BboxPt & { page: number }) => void
  /**
   * ドラッグ開始（pointerdown）時に1回通知する。
   * 親はここで「ドラッグ前 snapshot」を**一時退避**するだけ（まだ undoStack に積まない）。
   * 省略可（白塗りなど undo 不要の呼び出しは渡さない＝後方互換）。
   */
  onDragStart?: (name: string) => void
  /**
   * 新②undo（実機FB: 誤push修正）: ドラッグ確定（pointerup）時に通知する。
   *   changed=true（実際に bbox が変化した移動/リサイズ）のときのみ親が退避 snapshot を push する。
   *   changed=false（クリック＝選択のみ・移動量0）では push しない＝「戻る」が誤有効化しない。
   * 省略可（後方互換）。
   */
  onDragCommit?: (name: string, changed: boolean) => void
  /** 選択 bbox の画面位置を通知（フローティング nudge 配置・§A3）。 */
  onSelectionGeom?: (geom: SelectionGeom | null) => void
  /** ③ユーザーズーム倍率（PY1-1・既定 1.0）。displayWidth へ注入。 */
  zoom?: number
  /** ②縦フィット基準高さ（px・PY1-1）。省略時 高さ制約なし（従来）。 */
  viewportHeight?: number
  /** ④グリッド/中心線表示（PY1-4・描画のみ・座標非破壊）。 */
  showGrid?: boolean
  /**
   * 枠の見た目バリアント。
   *   - 'field'（既定）: 記入欄＝青枠（現状そのまま・段階1完了時と完全同一）。
   *   - 'whiteout'     : 白塗り＝灰色30%枠（記入欄の青と視覚差別化）。
   * 省略時 'field' で従来挙動を保証（記入欄側の呼び出しは無改変で動く＝後方互換）。
   * ⚠ 見た目のみ。座標計算（bbox-coords）・pointer ロジックは variant 非依存で共通＝ズレ温床ゼロ。
   */
  variant?: BboxVariant
  /**
   * 白塗り field の種別（auto=破線/manual=実線）を返す解決関数。
   * variant='whiteout' のときのみ参照。省略 or 戻り値 undefined は実線（manual 相当）。
   */
  whiteoutKindOf?: (name: string) => WhiteoutKind | undefined
  /**
   * 白塗りモードの raw 背景 PNG signedUrl（合成なし）。
   * variant='whiteout' かつ非 null のとき、<img> ではなく <canvas> に raw を描き、編集中の
   * fields（whiteoutFields）を compositeWhiteoutOnCanvas で都度合成する。削除した瞬間に
   * 合成対象から外れ元の文字が透ける（②本命 UX）＋ raw 固定でキャッシュ固着が消滅。
   * null のときは従来どおり imageUrl（焼込済 <img>）にフォールバック（raw 非対応テンプレ）。
   */
  whiteoutRawImageUrl?: string | null
  /**
   * 白塗り field の塗り色（estimatedBgColor）を返す解決関数。
   * canvas 合成で raw 上に塗る矩形の色。whiteoutRawImageUrl 使用時のみ参照。省略時は不透明白。
   */
  whiteoutBgColorOf?: (name: string) => RgbColor
  /**
   * #17・設計書 v1.8 §3-3-2: 動的プレビュー（全モード共通）の追加合成入力。
   *
   * - dynamicWhiteoutBoxes: 白塗りモード以外で「DB 保存済の白塗り」を canvas に重ねるための入力。
   *   白塗りモードは編集中 fields から自前で boxes を組むため省略する（後方互換）。
   * - dynamicFixedTexts: 全モード共通で固定テキストを動的合成するための入力。
   *   固定テキストモードでは編集中の fixedFields 由来、それ以外モードでは DB 保存値 fixed_texts。
   *   削除/value 変更で即 canvas 更新（焼き込み撤回・再編集不可バグ対策）。
   *
   * raw 経路が有効（whiteoutRawImageUrl があるとき）にのみ重ねる。raw 非対応テンプレでは
   * 従来 <img>（焼込済 _blank.pdf）にフォールバックし固定テキストの動的合成は無効になる
   * （旧データ後方互換・実害なし＝raw が無いと bbox-editor 経路自体が制限される）。
   */
  dynamicWhiteoutBoxes?: WhiteoutBox[]
  dynamicFixedTexts?: FixedText[]
  /**
   * 段階2-D2（設計書 v2.0 §1-2-3）: AdjustView 記入欄値の動的合成入力。
   *
   * 当該ページに属する items[]（field + value + override）を渡すと、canvas 上に
   * 「白塗り → 固定テキスト → 記入値」の順で重ね描画する（焼き込み残り二重描画ゼロ）。
   * useCanvasBg=true（raw URL あり）のときのみ機能する。空 / undefined は無描画＝従来挙動。
   */
  dynamicFieldValues?: FieldValueComposite[]
  /**
   * 段階2-D2（設計書 v2.0 §4 / §1-2-3）: 記入欄値合成時の uniform フォントサイズ（pt）。
   * 省略時は各 field.font.size を使う。per-field override.fontSize は uniform より優先。
   */
  fieldValuesUniformFontSize?: number
  /**
   * 🔴 段階2-D3（設計書 v2.2 §1-2-6 動的プレビュー vs PDF 完全一致・推し案 B）:
   * 記入欄値合成時に **PDF 出力経路（pdf-lib）と同じ OTF メトリクス** で wrap 判定するための
   * `FittableFont` 互換オブジェクト（opentype.js 経由・preview-font-loader 由来）。
   *
   * 渡された場合: `fitting.ts` の `wrapText` を呼ぶ → PDF 経路と wrap 位置・行数が完全一致。
   * 未渡し: `ctx.measureText` ベースの近似 wrap（v2.1 fallback・劣化プレビュー）。
   *
   * AdjustView のフォントロード未完了時 / SSR / 失敗時でも UI を止めないため undefined 許容。
   */
  fieldValuesPreviewFont?: FittableFont
  /**
   * もう片方のレイヤを薄く参考表示する read-only オーバーレイ。
   * 編集対象（fields）とは別に、選択/移動/リサイズ不可で薄く重ねるだけ（pointer-events-none）。
   * 例: 記入欄モードでは白塗りを、白塗りモードでは記入欄を薄く出して相互位置を確認できる（§4-1）。
   */
  referenceFields?: EditorField[]
  /** 参考レイヤの variant（薄表示の色味を編集対象と区別する）。省略時は編集対象の逆。 */
  referenceVariant?: BboxVariant
  /**
   * 段階2 Phase 2-D 修正（実機FB）: PDF プレビュー（背景画像）の実表示幅(px)を親へ通知する。
   * フローティングウィジェットの横幅を PDF 表示幅に追従させる（中央で同幅に縦並びさせる統一感）用。
   * displayWidth（containerWidth/縦フィット/zoom を反映した実描画幅）が変わるたびに呼ぶ。
   */
  onDisplayWidth?: (width: number) => void
  /**
   * C-2 v1.3 §3-2-5（A5）: 固定テキストモードの編集中プレビュー。
   * 各 field の `value` を bbox 内に fit-to-box（高さ基準・横溢れ縮小）で描画する。
   * `fixedTextValueOf` が非 undefined のときのみ、この pane を固定テキスト描画モードとみなす
   * （記入欄/白塗りモードでは渡さない＝描画なし・無改修）。空文字は枠のみ（描画なし）。
   */
  fixedTextValueOf?: (name: string) => string | undefined
  /**
   * C-2 v1.5 §3-2-3（縦横比保持 復活）: 4 隅ドラッグを**縦横比保持**でリサイズする。
   * true（固定テキストモード）のとき resizeBbox の代わりに resizeBboxKeepAspect を使い、
   * リサイズ開始時の bbox の aspect（w/h）を保ったまま拡縮する。
   * 省略/false（記入欄・白塗り）は従来の自由リサイズ（resizeBbox）＝無改修。
   */
  keepAspect?: boolean
  /**
   * AdjustView 専用のドラッグ中レイヤ凍結を
   * 有効化する。true のとき、bbox ドラッグ中（pane 内部 drag !== null の間）は重い背景フル
   * 再合成（compositeWhiteoutOnCanvas の全面 drawImage）をスキップし、freeze 時に撮った
   * ImageBitmap スナップショット + 移動 field の軽量描画だけを行う。
   *
   * 🚨 省略時 false = 従来挙動（templates 編集モードは常に false＝完全不変）。
   *   本フラグが false の経路は段階1完了時と 1px も変えない（既存行の削除・改変禁止・追加のみ）。
   */
  freezeDragLayer?: boolean
}

type DragState =
  | { kind: 'move'; name: string; startBbox: BboxPt; startX: number; startY: number }
  | {
      kind: 'resize'
      name: string
      corner: ResizeCorner
      startBbox: BboxPt
      startX: number
      startY: number
    }
  | null

const HANDLE_SIZE = 10 // 視覚サイズ（px）
// HIT_PAD（透明拡張の片側 px）。10 + 17*2 ≒ 44px 相当の WCAG タップ目標を最大値とする。
// 小 bbox（短辺 <60px・固定テキスト等）では bbox 中央まで侵食して移動判定を奪うため
// bbox 表示短辺に応じて動的に縮小する（小 bbox での移動判定 bugfix）。
const HIT_PAD_MAX = 17
const HIT_PAD_MIN = 2

const CORNERS: { corner: ResizeCorner; cx: 0 | 1; cy: 0 | 1; cursor: string }[] = [
  { corner: 'nw', cx: 0, cy: 0, cursor: 'nwse-resize' },
  { corner: 'ne', cx: 1, cy: 0, cursor: 'nesw-resize' },
  { corner: 'sw', cx: 0, cy: 1, cursor: 'nesw-resize' },
  { corner: 'se', cx: 1, cy: 1, cursor: 'nwse-resize' },
]

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
  const [drag, setDrag] = useState<DragState>(null)

  // ②動的プレビュー（§2-2 / §2-3）＋ #17（v1.8 §3-3-2）: 全モード共通の canvas 合成。
  //   - rawImg: raw 背景の HTMLImageElement（URL ごとに 1 回ロード）。
  //   - useCanvasBg: raw URL があれば全モード canvas 経路（<img> 不使用）。
  //     白塗りモード: 編集中 fields を都度合成（削除で透ける既存 UX）。
  //     記入欄/固定テキストモード: dynamicWhiteoutBoxes + dynamicFixedTexts を都度合成。
  // raw URL 無し（旧データ）は従来 <img>（焼込済 _blank.pdf）にフォールバック。
  const whiteoutCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const [rawImg, setRawImg] = useState<HTMLImageElement | null>(null)
  const useCanvasBg = !!whiteoutRawImageUrl

  // stale ベースレース根絶:
  //   現在 rawImg にロード済みの URL を保持する。drag 開始時に whiteoutRawImageUrl が
  //   selectedOnlyBgUrl（他 field テキスト焼込済 PNG）→ rawBgUrl（テキスト0）へ切替わると、
  //   下のロード effect が setRawImg(null) → 非同期再ロードする。再ロード完了前に
  //   captureDragSnapshot が走ると【旧 selectedOnlyBgUrl PNG（他 field テキスト焼込済）】を
  //   ベースに撮ってしまう。compositeFieldValuesOnCanvas は fillText の重ね描きで背景ピクセルを
  //   消さないため、S6a で新位置テキストを重ねると元位置テキストが残り【二重描画】になる。
  //   loadedUrlRef を見て「rawImg が現 whiteoutRawImageUrl をロード済みか」を確認してから撮る。
  const loadedUrlRef = useRef<string | null>(null)

  // raw 背景画像をロード（URL 変化で再ロード）。crossOrigin は signedUrl 同一オリジン相当で不要。
  useEffect(() => {
    if (!useCanvasBg || !whiteoutRawImageUrl) {
      setRawImg(null)
      loadedUrlRef.current = null // ロード対象なし → 既ロード URL を無効化。
      return
    }
    let cancelled = false
    loadedUrlRef.current = null // 再ロード開始 → 完了まで「未ロード」扱い（stale 撮影防止）。
    const img = new Image()
    img.onload = () => {
      if (!cancelled) {
        loadedUrlRef.current = whiteoutRawImageUrl // この URL のロード完了を記録。
        setRawImg(img)
      }
    }
    img.onerror = () => {
      if (!cancelled) {
        loadedUrlRef.current = null
        setRawImg(null)
      }
    }
    img.src = whiteoutRawImageUrl
    return () => {
      cancelled = true
    }
  }, [useCanvasBg, whiteoutRawImageUrl])

  // 編集中の whiteoutFields → WhiteoutBox[] を組み立て canvas に都度合成（§2-3 / §6-1）。
  // fields（追加/移動/削除）・rawImg・色解決が変わるたび再描画＝削除した瞬間に元の文字が透ける。
  //
  // #17（設計書 v1.8 §3-3-2）: 白塗りモード以外でも canvas 経路を使い、固定テキストを動的合成する。
  //   合成順: 背景(raw) → 白塗り → 固定テキスト（overlay PDF・サムネと一致）。
  //   白塗りモードでは fields = 編集中白塗り を boxes 化（従来挙動）。
  //   それ以外モードでは dynamicWhiteoutBoxes（DB 保存値）を使う。
  // CPU 飽和対策 (RAF 間引き):
  //   親 AdjustView の RAF 間引きで setOverrides は最大 60fps に制限されたが、
  //   この合成 useEffect 本体（drawImage 1200×1700 + 全 field opentype.js wrap 計算）は
  //   deps（dynamicFieldValues 等）の差替で 30-45 fps で走り続け CPU を占有していた。
  //
  //   案 A: useEffect 本体を requestAnimationFrame で coalesce。
  //   - 連続 deps 変化（pointermove 中の親 RAF flush 連発）に対し、次フレームまでの間に
  //     来た新依存は前 RAF を cancel + 再 schedule → 実描画は 1 回／フレームに収束。
  //   - cleanup（deps 変化 / unmount）で必ず cancelAnimationFrame → メモリリーク防止。
  //   - 描画結果は同じ（最終 deps 値で描画されるだけ）→ templates 編集モードでも挙動完全不変。
  //     templates 編集モードでも頻度が下がるだけで視覚上の差分は出ない（同じ最終フレーム）。
  // ドラッグ中レイヤ凍結:
  //   freezeDragLayer=true（adjust のみ）かつ pane 内部 drag 中は、重い背景フル再合成
  //   （compositeWhiteoutOnCanvas の全面 drawImage + 全 field wrap）をスキップし、freeze 時に
  //   1 回だけ撮った背景スナップ（move field 抜き）を貼り直して移動 field 1 件だけを軽量描画する。
  //   🚨 freezeDragLayer=false（templates / 省略時）の経路は 1px たりとも変えない（従来パス固定）。
  const dragSnapshotRef = useRef<ImageBitmap | HTMLCanvasElement | null>(null)
  // freeze スナップが ready になったら再レンダー → 合成 useEffect を軽量パスで再走させるトリガ。
  const [dragSnapshotReady, setDragSnapshotReady] = useState(false)
  // createImageBitmap の非同期完了が drag 終了後に届いた場合に取りこぼしを close するための世代印。
  const dragGenRef = useRef(0)
  // 撮影 in-flight 中フラグ（つなぎフレームで多重に createImageBitmap をキックしない）。
  const capturingRef = useRef(false)

  // スナップ解放ヘルパ（drop / cancel / unmount / 撮り直しで必ず close）。
  function releaseDragSnapshot() {
    const snap = dragSnapshotRef.current
    dragSnapshotRef.current = null
    if (snap && typeof (snap as ImageBitmap).close === 'function') {
      try {
        ;(snap as ImageBitmap).close()
      } catch {
        // ignore
      }
    }
  }

  // freeze スナップ撮影:
  //   move field（movingName）を**除いた**背景（raw + 白塗り + 固定テキスト + 他 field 記入値）を
  //   オフスクリーン canvas に 1 回だけフル合成し、ImageBitmap 化して dragSnapshotRef に保持する。
  //   重い全面 drawImage + 全 field wrap はこの撮影 1 回のみ走る（以降の drag フレームは軽量）。
  //
  //   防御（設計書 S3 / §5 第3候補）: createImageBitmap が無い / 失敗した場合は ImageBitmap 化を
  //   諦めて何もしない（dragSnapshotRef は null のまま）→ 合成 useEffect は毎フレーム従来パスへ
  //   フォールバックし、クラッシュしない（性能改善はしないがバグらない・最低限の防御）。
  //   ※ オフスクリーン canvas をスナップに使う完全 fallback（§5 第2候補）は S4 スコープ外。
  function captureDragSnapshot(movingName: string) {
    if (capturingRef.current) return // 撮影 in-flight 中は多重キックしない。
    if (typeof createImageBitmap !== 'function') return // §5 第3候補（従来パス据置）。
    const rawImage = rawImg
    if (!rawImage) return
    // stale ベースレースガード:
    //   rawImg にロード済みの URL が現在の whiteoutRawImageUrl と一致しないなら、まだ
    //   旧 URL（selectedOnlyBgUrl・他 field テキスト焼込済）の画像を掴んでいる可能性がある。
    //   その画像をベースに撮ると元位置テキストが焼き込まれ二重描画になるので、撮影をスキップする。
    //   return するだけ（呼び出し元 §3-2-1 は撮影しても return せず従来フル合成でつなぐため、
    //   この frame は正しいフル合成で描かれ、rawImg が rawBgUrl をロードし終えた次フレームで
    //   dynamicFieldValues / drag 変化により本 effect が再走し撮影が成立する＝無限スキップしない）。
    if (loadedUrlRef.current !== whiteoutRawImageUrl) return
    const gen = dragGenRef.current

    let off: HTMLCanvasElement
    try {
      off = document.createElement('canvas')
      off.width = meta.pixelWidth
      off.height = meta.pixelHeight
    } catch {
      return // canvas 生成失敗 → 従来パス据置（クラッシュしない）。
    }

    // 従来の合成順（背景+白塗り → 固定テキスト → 記入値）を offscreen に再現。move field は除外。
    const boxes: WhiteoutBox[] =
      variant === 'whiteout'
        ? fields
            .filter((f) => f.name !== movingName)
            .map((f) => ({
              page: f.bbox.page,
              bbox: { x: f.bbox.x, y: f.bbox.y, w: f.bbox.w, h: f.bbox.h },
              estimatedBgColor: whiteoutBgColorOf?.(f.name) ?? { r: 255, g: 255, b: 255 },
              source: 'manual' as const,
            }))
        : (dynamicWhiteoutBoxes ?? []).filter((b) => b.page === meta.page)

    try {
      compositeWhiteoutOnCanvas(
        off,
        rawImage,
        boxes,
        meta.pixelWidth,
        meta.pixelHeight,
        meta.widthPt,
        meta.heightPt,
      )

      if (dynamicFixedTexts && dynamicFixedTexts.length > 0) {
        const pageTexts = dynamicFixedTexts.filter((t) => t.bbox.page === meta.page)
        if (pageTexts.length > 0) {
          compositeFixedTextsOnCanvas(
            off,
            pageTexts,
            meta.pixelWidth,
            meta.pixelHeight,
            meta.widthPt,
            meta.heightPt,
          )
        }
      }

      if (dynamicFieldValues && dynamicFieldValues.length > 0) {
        // move field を除いた他 field の記入値だけを焼き込む（move field は軽量レイヤで描く）。
        const pageItems = dynamicFieldValues.filter(
          (it) => it.field.bbox.page === meta.page && it.field.name !== movingName,
        )
        if (pageItems.length > 0) {
          const compOpts:
            | { uniformFontSize?: number; previewFont?: FittableFont }
            | undefined =
            fieldValuesUniformFontSize !== undefined || fieldValuesPreviewFont
              ? {
                  ...(fieldValuesUniformFontSize !== undefined
                    ? { uniformFontSize: fieldValuesUniformFontSize }
                    : {}),
                  ...(fieldValuesPreviewFont
                    ? { previewFont: fieldValuesPreviewFont }
                    : {}),
                }
              : undefined
          compositeFieldValuesOnCanvas(
            off,
            pageItems,
            meta.pixelWidth,
            meta.pixelHeight,
            meta.widthPt,
            meta.heightPt,
            compOpts,
          )
        }
      }
    } catch {
      return // 合成失敗 → 従来パス据置（クラッシュしない）。
    }

    // offscreen を ImageBitmap 化（非同期）。完了時に drag が続いていればスナップ採用。
    capturingRef.current = true
    createImageBitmap(off)
      .then((bmp) => {
        capturingRef.current = false
        // 撮影中に drop / 撮り直し（世代変化）が起きていたら破棄してリーク防止。
        if (gen !== dragGenRef.current || !drag) {
          bmp.close()
          return
        }
        // 既に別スナップがあれば close してから差し替え（撮り直し時の保険）。
        if (dragSnapshotRef.current) releaseDragSnapshot()
        dragSnapshotRef.current = bmp
        setDragSnapshotReady(true) // 再走 → 次フレームから軽量パス。
      })
      .catch(() => {
        // §5 第3候補: ImageBitmap 化失敗 → 従来パス据置（クラッシュしない）。
        capturingRef.current = false
      })
  }

  // drag 終了（drag が null に戻った）検出 → スナップ破棄 + ready リセット。
  //   freezeDragLayer ガード下のみ。drop で freezeDragLayer&&drag が false に戻ると、下の合成
  //   useEffect が次フレームで 1 回だけ従来フル再合成を走らせピクセル一致に回復する。
  //   unmount 時も cleanup で close（メモリリーク防止）。
  useEffect(() => {
    if (!freezeDragLayer) return
    if (!drag) {
      dragGenRef.current += 1 // 進行中の撮影 Promise を無効化（遅れて届いても close される）。
      capturingRef.current = false // 次の drag のために撮影フラグも解除。
      releaseDragSnapshot()
      if (dragSnapshotReady) setDragSnapshotReady(false)
    }
    return () => {
      // unmount / freezeDragLayer 変化時の保険。
      releaseDragSnapshot()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freezeDragLayer, drag])

  useEffect(() => {
    if (!useCanvasBg) return
    const canvas = whiteoutCanvasRef.current
    if (!canvas || !rawImg) return

    // freeze 軽量パス。freezeDragLayer&&drag のときだけ走る（templates は drag 中でも
    //   freezeDragLayer=false なので必ず下の従来パスへ＝完全不変）。スナップ未 ready の最初の
    //   1〜2 フレームは撮影をキックしつつ従来描画でつなぐ（return せず下へ落とす）。
    if (freezeDragLayer && drag) {
      const ctx = canvas.getContext('2d')
      if (ctx) {
        if (canvas.width !== meta.pixelWidth) canvas.width = meta.pixelWidth
        if (canvas.height !== meta.pixelHeight) canvas.height = meta.pixelHeight

        // 移動中 field（pane 内部 drag.name）。当該ページの items から取り出す。
        const movingItem = (dynamicFieldValues ?? []).find(
          (it) => it.field.name === drag.name && it.field.bbox.page === meta.page,
        )

        if (dragSnapshotRef.current && movingItem) {
          // スナップ ready → 軽量描画（背景貼り直し + 移動 field 1 件）。重い再合成はしない。
          const snapshot = dragSnapshotRef.current
          const fvOptions =
            fieldValuesUniformFontSize !== undefined || fieldValuesPreviewFont
              ? {
                  ...(fieldValuesUniformFontSize !== undefined
                    ? { uniformFontSize: fieldValuesUniformFontSize }
                    : {}),
                  ...(fieldValuesPreviewFont
                    ? { previewFont: fieldValuesPreviewFont }
                    : {}),
                }
              : undefined
          const rafId = requestAnimationFrame(() => {
            paintDraggingField(
              ctx,
              snapshot,
              movingItem,
              meta.pixelWidth,
              meta.pixelHeight,
              meta.widthPt,
              meta.heightPt,
              fvOptions,
            )
          })
          return () => cancelAnimationFrame(rafId)
        }

        // スナップ未撮影 → 撮影をキック（move field 抜きでフル合成 → ImageBitmap）。
        //   このフレームは従来描画でつなぐ（return せず下の従来パスへ）。撮影完了で
        //   dragSnapshotReady を立て再走 → 次フレームから軽量パス。
        if (!dragSnapshotRef.current && movingItem) {
          captureDragSnapshot(drag.name)
        }
      }
      // ↓ つなぎフレームは従来パスへフォールバック（return しない）。
    }

    const rafId = requestAnimationFrame(() => {
      // canvas backing store は raw のネイティブ px に固定（whiteoutBoxToPxRect の写像先と一致）。
      if (canvas.width !== meta.pixelWidth) canvas.width = meta.pixelWidth
      if (canvas.height !== meta.pixelHeight) canvas.height = meta.pixelHeight

      const boxes: WhiteoutBox[] =
        variant === 'whiteout'
          ? fields.map((f) => ({
              page: f.bbox.page,
              bbox: { x: f.bbox.x, y: f.bbox.y, w: f.bbox.w, h: f.bbox.h },
              estimatedBgColor: whiteoutBgColorOf?.(f.name) ?? { r: 255, g: 255, b: 255 },
              source: 'manual',
            }))
          : (dynamicWhiteoutBoxes ?? []).filter((b) => b.page === meta.page)

      // ① 背景 + 白塗り合成（clearRect → drawImage(raw) → fillRect(boxes)）。
      compositeWhiteoutOnCanvas(
        canvas,
        rawImg,
        boxes,
        meta.pixelWidth,
        meta.pixelHeight,
        meta.widthPt,
        meta.heightPt,
      )

      // ② 固定テキスト合成（白塗りの上に fillText を重ねる）。当該ページぶんだけ。
      //    固定テキストモードでは編集中の値が即反映（焼き込みの再編集不可問題を構造解決）。
      if (dynamicFixedTexts && dynamicFixedTexts.length > 0) {
        const pageTexts = dynamicFixedTexts.filter((t) => t.bbox.page === meta.page)
        if (pageTexts.length > 0) {
          compositeFixedTextsOnCanvas(
            canvas,
            pageTexts,
            meta.pixelWidth,
            meta.pixelHeight,
            meta.widthPt,
            meta.heightPt,
          )
        }
      }

      // ③ 記入欄値合成（段階2-D2・設計書 v2.0 §1-2-3 / §1-2-4）: 白塗り → 固定テキスト → 記入値
      //    の合成順を厳守。AdjustView は raw 背景（記入値ゼロ）+ ここで合成 = 二重描画ゼロ。
      //    値編集 / 削除で即座に再合成（dynamicFieldValues 配列差替で useEffect が再走）。
      if (dynamicFieldValues && dynamicFieldValues.length > 0) {
        const pageItems = dynamicFieldValues.filter(
          (it) => it.field.bbox.page === meta.page,
        )
        if (pageItems.length > 0) {
          // 🔴 段階2-D3（§1-2-6）: previewFont 渡しありなら PDF と wrap 完全一致 / なしなら fallback
          const compOpts:
            | { uniformFontSize?: number; previewFont?: FittableFont }
            | undefined =
            fieldValuesUniformFontSize !== undefined || fieldValuesPreviewFont
              ? {
                  ...(fieldValuesUniformFontSize !== undefined
                    ? { uniformFontSize: fieldValuesUniformFontSize }
                    : {}),
                  ...(fieldValuesPreviewFont
                    ? { previewFont: fieldValuesPreviewFont }
                    : {}),
                }
              : undefined
          compositeFieldValuesOnCanvas(
            canvas,
            pageItems,
            meta.pixelWidth,
            meta.pixelHeight,
            meta.widthPt,
            meta.heightPt,
            compOpts,
          )
        }
      }
    })

    // 🔴 段階2-D12: cleanup で必ず cancel。
    //   deps 変化（連続 pointermove で dynamicFieldValues が高頻度差替）時、
    //   前 RAF をキャンセル → 最新 deps での 1 回だけが次フレームで実描画される。
    //   これが「30-45 fps で走り続ける合成 useEffect → 最大 60fps に制限」の中核。
    return () => {
      cancelAnimationFrame(rafId)
    }
    // freeze 分岐の依存（freezeDragLayer / drag / dragSnapshotReady）を deps に追加。
    //   - freezeDragLayer=false（templates）では if 分岐に一切入らず従来パスのみ＝挙動完全不変。
    //     deps に false（不変値）が増えても再走トリガにはならない。
    //   - drag は freezeDragLayer=true のときだけ意味を持つ。templates でも drag は変化するが、
    //     その時 dynamicFieldValues 等も変化し既に再走済み（従来挙動と同じ最終フレームに収束）。
    //   - dragSnapshotReady は撮影完了で軽量パスへ切り替える再走トリガ。
    //   captureDragSnapshot は安定参照（毎レンダー再生成だが ref/setState のみ参照）なので除外。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    useCanvasBg,
    rawImg,
    fields,
    meta,
    variant,
    whiteoutBgColorOf,
    dynamicWhiteoutBoxes,
    dynamicFixedTexts,
    dynamicFieldValues,
    fieldValuesUniformFontSize,
    fieldValuesPreviewFont,
    freezeDragLayer,
    drag,
    dragSnapshotReady,
  ])

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

  // wrapper（座標系コンテナ）は border を持たず（outline 化・§A2-2）、size=dispW/dispH ちょうど。
  // よって getBoundingClientRect の left/top は padding-box（=bbox 座標原点）と一致する。
  function clientToDisplay(e: React.PointerEvent): { x: number; y: number } | null {
    const el = wrapperRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function startMove(e: React.PointerEvent, f: EditorField) {
    if (e.button !== undefined && e.button !== 0) return
    const p = clientToDisplay(e)
    if (!p) return
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    onSelect(f.name)
    onDragStart?.(f.name) // undo: ドラッグ前 snapshot を親が push（§2-2）。
    setDrag({
      kind: 'move',
      name: f.name,
      startBbox: { ...f.bbox },
      startX: p.x,
      startY: p.y,
    })
  }

  function startResize(e: React.PointerEvent, f: EditorField, corner: ResizeCorner) {
    if (e.button !== undefined && e.button !== 0) return
    const p = clientToDisplay(e)
    if (!p) return
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    onSelect(f.name)
    onDragStart?.(f.name) // undo: ドラッグ前 snapshot を親が push（§2-2）。
    setDrag({
      kind: 'resize',
      name: f.name,
      corner,
      startBbox: { ...f.bbox },
      startX: p.x,
      startY: p.y,
    })
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!drag) return
    const p = clientToDisplay(e)
    if (!p) return
    // 表示 px の移動量 → pt の移動量（pt 空間で startBbox に適用）。
    // 描画と同じ fitOpts を使い、往復一致（±4px）を保つ（§A1 / PY1-0）。
    const dxPt = dispToPtX(meta, p.x - drag.startX, fitOpts)
    const dyPt = dispToPtY(meta, p.y - drag.startY, fitOpts)
    const f = fields.find((ff) => ff.name === drag.name)
    if (!f) return
    let next: BboxPt
    if (drag.kind === 'move') {
      // 移動: w/h 固定で x/y をページ内へ引き戻す。
      next = clampToPage(moveBbox(drag.startBbox, dxPt, dyPt))
    } else if (keepAspect) {
      // C-2 v1.5（§3-2-3）: 固定テキストは縦横比保持リサイズ。aspect は開始時 bbox の w/h。
      // ラッパが対角 anchor 固定・長辺基準・ページ端クランプ（比率保持）まで担うので clampResizeToPage は不要。
      const aspect = drag.startBbox.h > 0 ? drag.startBbox.w / drag.startBbox.h : 1
      next = resizeBboxKeepAspect(drag.startBbox, drag.corner, dxPt, dyPt, aspect, meta)
    } else {
      // リサイズ: x/y を引き戻さず、はみ出した辺だけ縮める（綱引き回避・差し戻し-3）。
      next = clampResizeToPage(
        resizeBbox(drag.startBbox, drag.corner, dxPt, dyPt),
        meta,
      )
    }
    onChangeBbox(drag.name, { ...next, page: f.bbox.page })
  }

  function endDrag(e: React.PointerEvent) {
    if (!drag) return
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      // ignore
    }
    // undo 誤push修正（実機FB）: クリックのみ（移動量0）なら bbox は不変＝push しない。
    // 確定時の bbox を startBbox と比較し、実際に変化したときだけ親へ commit(changed=true)。
    const f = fields.find((ff) => ff.name === drag.name)
    const start = drag.startBbox
    const changed =
      !!f &&
      (f.bbox.x !== start.x ||
        f.bbox.y !== start.y ||
        f.bbox.w !== start.w ||
        f.bbox.h !== start.h)
    onDragCommit?.(drag.name, changed)
    setDrag(null)
  }

  /** ドラッグ中もページ範囲内に収める（S1）。w/h は維持。 */
  function clampToPage(b: BboxPt): BboxPt {
    const x = Math.max(0, Math.min(b.x, meta.widthPt - b.w))
    const y = Math.max(0, Math.min(b.y, meta.heightPt - b.h))
    return { x, y, w: b.w, h: b.h }
  }

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

        {/* 参考レイヤ（§4-1）: もう片方のレイヤを薄く read-only 表示。
            編集対象（fields）の下に敷き、選択/ドラッグ不可（pointer-events-none）。
            相互の位置関係を見ながら編集できるようにするための非編集オーバーレイ。 */}
        {referenceFields?.map((rf) => {
          const left = ptToDispX(meta, rf.bbox.x, fitOpts)
          const top = ptToDispY(meta, rf.bbox.y, fitOpts)
          const w = ptToDispX(meta, rf.bbox.x + rf.bbox.w, fitOpts) - left
          const h = ptToDispY(meta, rf.bbox.y + rf.bbox.h, fitOpts) - top
          const refVar: BboxVariant =
            referenceVariant ?? (variant === 'field' ? 'whiteout' : 'field')
          return (
            <div
              key={`ref-${rf.name}`}
              className={
                'absolute border-2 pointer-events-none opacity-40 ' +
                bboxBoxClass(refVar, false)
              }
              style={{
                left,
                top,
                width: Math.max(2, w),
                height: Math.max(2, h),
              }}
            />
          )
        })}

        {fields.map((f) => {
          const left = ptToDispX(meta, f.bbox.x, fitOpts)
          const top = ptToDispY(meta, f.bbox.y, fitOpts)
          const w = ptToDispX(meta, f.bbox.x + f.bbox.w, fitOpts) - left
          const h = ptToDispY(meta, f.bbox.y + f.bbox.h, fitOpts) - top
          const selected = f.name === selectedName
          return (
            <div
              key={f.name}
              data-box
              onPointerDown={(e) => startMove(e, f)}
              className={
                'absolute border-2 cursor-move ' +
                bboxBoxClass(variant, selected, whiteoutKindOf?.(f.name))
              }
              style={{
                left,
                top,
                width: Math.max(2, w),
                height: Math.max(2, h),
              }}
            >
              {/* C-2 v1.3 §3-2-5（A5）: 固定テキストモードのみ、bbox 内に value を fit-to-box 描画。
                  サイズは表示高さ基準（dispH * RATIO）で px 換算済み（pt→px は w/h が既に表示px）。
                  横溢れは overflow:hidden でクリップ（最終出力は overlay の fitText が真実・近似表示）。
                  空 value は枠のみ（描画なし）。
                  #17（v1.8 §3-3-2）: canvas 経路時（useCanvasBg）は dynamicFixedTexts が canvas に
                  描画するため span プレビューは出さない（二重描画回避）。raw 非対応テンプレでのみ
                  span プレビューが従来どおり残る（後方互換）。 */}
              {(() => {
                if (!fixedTextValueOf) return null
                if (useCanvasBg) return null
                const text = fixedTextValueOf(f.name) ?? ''
                if (text.trim() === '') return null
                // v1.7（改行対応）: 1 行あたり fontPx = (h / N) * RATIO・各行を縦に並べる。
                const lines = text.split('\n')
                const n = Math.max(1, lines.length)
                const fontPx = Math.max(6, (h / n) * FIXED_TEXT_FONT_SIZE_RATIO)
                return (
                  <span
                    className="absolute inset-0 flex flex-col items-center justify-center overflow-hidden pointer-events-none text-gray-900 leading-none"
                    style={{ fontSize: fontPx, fontFamily: 'NotoSansJP, sans-serif' }}
                  >
                    {lines.map((line, i) => (
                      <span
                        key={i}
                        className="block whitespace-nowrap"
                        style={{ lineHeight: `${fontPx / FIXED_TEXT_FONT_SIZE_RATIO}px` }}
                      >
                        {line || ' '}
                      </span>
                    ))}
                  </span>
                )
              })()}

              {/* 日本語 label のみ。枠内左上＋選択中のみ表示（密集かぶり回避・§A4）。
                  固定テキストモード（fixedTextValueOf あり）は value を中央プレビューで出すため、
                  左上 label バッジは出さない（value と二重表示になるのを防ぐ）。 */}
              {selected && !fixedTextValueOf && (
                <span
                  className={
                    'absolute top-0 left-0 text-[10px] leading-none px-1 py-0.5 rounded-br whitespace-nowrap pointer-events-none ' +
                    bboxLabelClass(variant)
                  }
                >
                  {f.label}
                </span>
              )}

              {selected &&
                CORNERS.map(({ corner, cx, cy, cursor }) => {
                  // bbox 表示短辺に連動して HIT_PAD を縮小（2026-06-14 bugfix）。
                  //   - 短辺 >=60px: HIT_PAD_MAX(17) ＝ 44px 相当（WCAG タップ目標維持）
                  //   - 短辺 <60px: 短辺/8 を採用（最小 HIT_PAD_MIN=2 でクランプ）
                  //     例) 短辺50px → pad=6 → ハンドル合計22px。bbox 中央タップ判定を確保。
                  const shortSidePx = Math.min(w, h)
                  const hitPad =
                    shortSidePx < 60
                      ? Math.max(HIT_PAD_MIN, Math.floor(shortSidePx / 8))
                      : HIT_PAD_MAX
                  return (
                    <div
                      key={corner}
                      onPointerDown={(e) => startResize(e, f, corner)}
                      // 透明拡張ヒットエリア（最大 44px 相当・小 bbox では動的縮小）。
                      // 視覚は内側の小ハンドル（HANDLE_SIZE 固定）。
                      style={{
                        position: 'absolute',
                        left: cx === 0 ? -hitPad : undefined,
                        right: cx === 1 ? -hitPad : undefined,
                        top: cy === 0 ? -hitPad : undefined,
                        bottom: cy === 1 ? -hitPad : undefined,
                        width: HANDLE_SIZE + hitPad * 2,
                        height: HANDLE_SIZE + hitPad * 2,
                        cursor,
                        touchAction: 'none',
                      }}
                      className="flex items-center justify-center"
                      aria-label={`${f.label} のサイズ変更ハンドル`}
                    >
                      <span
                        style={{ width: HANDLE_SIZE, height: HANDLE_SIZE }}
                        className={bboxHandleClass(variant)}
                      />
                    </div>
                  )
                })}
            </div>
          )
        })}

            {/* ④グリッド/中心線オーバーレイ（PY1-4・描画のみ・fields 非破壊）。
                テンプレ中心（薄破線の十字）＋選択青枠中心（青実線の十字）。 */}
            {showGrid && (
              <div className="absolute inset-0 pointer-events-none">
                {/* テンプレ中心: 縦線(left=dispW/2)＋横線(top=dispH/2) */}
                <div
                  className="absolute top-0 bottom-0 border-l border-dashed border-gray-400/70"
                  style={{ left: dispW / 2 }}
                />
                <div
                  className="absolute left-0 right-0 border-t border-dashed border-gray-400/70"
                  style={{ top: dispH / 2 }}
                />
                {/* 選択青枠中心: 縦線＋横線（青実線）。中央寄せでテンプレ中心線と重なる。 */}
                {selCenter && (
                  <>
                    <div
                      className="absolute top-0 bottom-0 border-l border-gizirotto-blue-600/80"
                      style={{ left: selCenter.x }}
                    />
                    <div
                      className="absolute left-0 right-0 border-t border-gizirotto-blue-600/80"
                      style={{ top: selCenter.y }}
                    />
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
