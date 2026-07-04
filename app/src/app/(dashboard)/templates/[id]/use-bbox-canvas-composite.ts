'use client'

/**
 * bbox canvas 動的合成エンジン + ドラッグ中レイヤ凍結（bbox-pane.tsx から分離）。
 *
 * 背景（raw PNG）→ 白塗り → 固定テキスト → 記入値の順で <canvas> に都度合成する。
 * ドラッグ中は freezeDragLayer 有効時のみ、重い全面再合成を省略した軽量パスへ切り替える。
 */
import { useEffect, useRef, useState } from 'react'
import { type PageMeta } from '@/lib/pdf-output/bbox-coords'
import { type BboxVariant } from './bbox-variant'
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
import type { FixedText } from '@/lib/pdf-output/fixedtext-adapter'
import type { EditorField } from './bbox-pane'
import type { DragState } from './use-pointer-bbox-edit'

export interface UseBboxCanvasCompositeParams {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  meta: PageMeta
  variant: BboxVariant
  fields: EditorField[]
  useCanvasBg: boolean
  whiteoutRawImageUrl?: string | null
  whiteoutBgColorOf?: (name: string) => RgbColor
  dynamicWhiteoutBoxes?: WhiteoutBox[]
  dynamicFixedTexts?: FixedText[]
  dynamicFieldValues?: FieldValueComposite[]
  fieldValuesUniformFontSize?: number
  fieldValuesPreviewFont?: FittableFont
  freezeDragLayer: boolean
  drag: DragState
}

export function useBboxCanvasComposite({
  canvasRef,
  meta,
  variant,
  fields,
  useCanvasBg,
  whiteoutRawImageUrl,
  whiteoutBgColorOf,
  dynamicWhiteoutBoxes,
  dynamicFixedTexts,
  dynamicFieldValues,
  fieldValuesUniformFontSize,
  fieldValuesPreviewFont,
  freezeDragLayer,
  drag,
}: UseBboxCanvasCompositeParams): void {
  // ②動的プレビュー（§2-2 / §2-3）＋ #17（v1.8 §3-3-2）: 全モード共通の canvas 合成。
  //   - rawImg: raw 背景の HTMLImageElement（URL ごとに 1 回ロード）。
  //   - useCanvasBg: raw URL があれば全モード canvas 経路（<img> 不使用）。
  //     白塗りモード: 編集中 fields を都度合成（削除で透ける既存 UX）。
  //     記入欄/固定テキストモード: dynamicWhiteoutBoxes + dynamicFixedTexts を都度合成。
  // raw URL 無し（旧データ）は従来 <img>（焼込済 _blank.pdf）にフォールバック。
  const [rawImg, setRawImg] = useState<HTMLImageElement | null>(null)

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
    const canvas = canvasRef.current
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
}
