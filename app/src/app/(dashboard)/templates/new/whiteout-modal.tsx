'use client'

/**
 * 白塗りモーダル（設計書 v1.4.2 §3-6-b パス B プレビュー UI）。
 *
 * フロー:
 *   1. mount 時に /api/templates/pdf/whiteout-preview を呼ぶ
 *      → boxes: WhiteoutBox[] + previewImageUrls + pageSizes 取得
 *   2. 各ページ画像の上にオーバーレイ canvas を重ね、
 *      - サジェスト矩形: 薄い青ハイライト（クリックで採用 / 削除トグル）
 *      - ユーザー追加矩形: 白塗りプレビュー + × 削除ボタン
 *      - 空白領域でマウスドラッグ → 新規矩形追加
 *   3. 「白塗りを確定する」ボタン → /api/templates/pdf/whiteout-apply
 *      → 完了で onDone を呼ぶ
 *
 * 座標系:
 *   - 表示: 画像 px（width/height は pageSizes.pixel*）
 *   - 保存: PDF pt（左上原点、PdfBox 共通）
 *   - 変換比: scaleX = widthPt / pixelWidth, scaleY = heightPt / pixelHeight
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ErrorNotice from '@/components/error-notice'
import { humanizeErrorCode } from '@/lib/errors/user-message'

interface RgbColor {
  r: number
  g: number
  b: number
}

interface PdfBoxPt {
  x: number
  y: number
  w: number
  h: number
}

interface WhiteoutBox {
  page: number
  bbox: PdfBoxPt
  estimatedBgColor: RgbColor
  source: 'auto_suggestion' | 'manual'
}

interface PageMeta {
  page: number
  widthPt: number
  heightPt: number
  pixelWidth: number
  pixelHeight: number
}

interface PreviewResponse {
  boxes: WhiteoutBox[]
  previewImageUrls: (string | null)[]
  pageSizes: PageMeta[]
}

interface Props {
  templateId: string
  onDone: (templateId: string) => void
  /** モーダルを閉じて前のステップ（アップロード/モード選択）へ戻す。どの状態でも呼べる導線用。 */
  onClose: () => void
}

interface BoxState extends WhiteoutBox {
  /** UI 内部 ID（描画 / 削除用） */
  id: string
  /** サジェストを「ユーザー却下した」フラグ。true なら塗らない */
  dismissed?: boolean
}

const DEFAULT_BG_WHITE: RgbColor = { r: 255, g: 255, b: 255 }

function genId(): string {
  return `b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 失敗レスポンスから「エラーコード文字列」を取り出す（表示層で humanizeErrorCode に渡す用）。
 * API は `{ error: CODE }` を返すのでそれを優先。取れなければ HTTP ステータスを載せた合成文字列。
 * detail 等の生メッセージは UI で表示しないので拾わない（漏洩防止）。
 */
async function readErrorCode(res: Response): Promise<string> {
  try {
    const body = (await res.clone().json()) as { error?: unknown }
    if (typeof body?.error === 'string' && body.error) return body.error
  } catch {
    // JSON でない/空ボディ → ステータスのみ
  }
  return `HTTP_${res.status}`
}

export default function WhiteoutModal({ templateId, onDone, onClose }: Props) {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'applying' | 'error'>(
    'loading',
  )
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [previewImageUrls, setPreviewImageUrls] = useState<(string | null)[]>(
    [],
  )
  const [pageSizes, setPageSizes] = useState<PageMeta[]>([])
  const [boxes, setBoxes] = useState<BoxState[]>([])

  // 初回ロード: preview API
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/templates/pdf/whiteout-preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ templateId }),
        })
        if (!res.ok) {
          throw new Error(await readErrorCode(res))
        }
        const data = (await res.json()) as PreviewResponse
        if (cancelled) return
        setPreviewImageUrls(data.previewImageUrls)
        setPageSizes(data.pageSizes)
        setBoxes(
          data.boxes.map((b) => ({
            ...b,
            id: genId(),
          })),
        )
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

  async function handleApply() {
    setPhase('applying')
    setErrorMsg(null)
    const activeBoxes: WhiteoutBox[] = boxes
      .filter((b) => !b.dismissed)
      .map((b) => ({
        page: b.page,
        bbox: b.bbox,
        estimatedBgColor: b.estimatedBgColor,
        source: b.source,
      }))
    try {
      const res = await fetch('/api/templates/pdf/whiteout-apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId, boxes: activeBoxes }),
      })
      if (!res.ok) {
        throw new Error(await readErrorCode(res))
      }
      onDone(templateId)
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
      setPhase('ready')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-5xl w-full max-h-[90vh] flex flex-col">
        <header className="px-5 py-3 border-b flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-serif text-gizirotto-blue-900">
              白く塗りつぶす場所を選ぶ
            </h2>
            <p className="text-xs text-gray-500">
              書き込み済みの場所をマウスでドラッグして囲んでください。
            </p>
          </div>
          {/* どの状態（読み込み/エラー/編集中/保存中）でも閉じられる常設の × 導線。 */}
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じて前の画面に戻る"
            title="閉じて前の画面に戻る"
            className="shrink-0 w-8 h-8 rounded-full text-gray-500 hover:text-gizirotto-blue-900 hover:bg-gizirotto-blue-500/10 flex items-center justify-center text-xl leading-none"
          >
            ×
          </button>
        </header>

        <div className="flex-1 overflow-auto p-4 space-y-6">
          {phase === 'loading' && (
            <p className="text-sm text-gray-600">
              PDF を読み込んでいます…（書き込み候補も探しています）
            </p>
          )}
          {phase === 'error' && (
            <div className="space-y-3">
              <ErrorNotice code={errorMsg} prefix="読み込みに失敗しました" />
              <button
                type="button"
                onClick={onClose}
                className="bg-white border border-gizirotto-blue-500 text-gizirotto-blue-700 hover:bg-gizirotto-blue-500/10 font-medium px-4 py-2 rounded text-sm"
              >
                戻る
              </button>
            </div>
          )}
          {(phase === 'ready' || phase === 'applying') &&
            pageSizes.map((meta) => (
              <PagePane
                key={meta.page}
                meta={meta}
                imageUrl={previewImageUrls[meta.page - 1] ?? null}
                boxes={boxes.filter((b) => b.page === meta.page)}
                onAddBox={(bbox) =>
                  setBoxes((prev) => [
                    ...prev,
                    {
                      id: genId(),
                      page: meta.page,
                      bbox,
                      estimatedBgColor: DEFAULT_BG_WHITE,
                      source: 'manual',
                    },
                  ])
                }
                onRemoveBox={(id) =>
                  setBoxes((prev) => prev.filter((b) => b.id !== id))
                }
                onToggleSuggestion={(id) =>
                  setBoxes((prev) =>
                    prev.map((b) =>
                      b.id === id ? { ...b, dismissed: !b.dismissed } : b,
                    ),
                  )
                }
              />
            ))}
        </div>

        <footer className="px-5 py-3 border-t flex items-center justify-between gap-3">
          <p className="text-xs text-gray-500">
            塗る場所: {boxes.filter((b) => !b.dismissed).length} 箇所
          </p>
          {errorMsg && phase === 'ready' && (
            <p className="text-xs text-red-600 flex-1">
              {humanizeErrorCode(errorMsg).message}
            </p>
          )}
          <button
            type="button"
            onClick={handleApply}
            disabled={phase !== 'ready'}
            className="bg-gizirotto-blue-500 hover:bg-gizirotto-blue-700 text-white font-medium px-4 py-2 rounded disabled:opacity-50"
          >
            {phase === 'applying' ? '保存中…' : '白塗りを確定する'}
          </button>
        </footer>
      </div>
    </div>
  )
}

interface PagePaneProps {
  meta: PageMeta
  imageUrl: string | null
  boxes: BoxState[]
  onAddBox: (bbox: PdfBoxPt) => void
  onRemoveBox: (id: string) => void
  onToggleSuggestion: (id: string) => void
}

function PagePane({
  meta,
  imageUrl,
  boxes,
  onAddBox,
  onRemoveBox,
  onToggleSuggestion,
}: PagePaneProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const [drag, setDrag] = useState<{
    startX: number
    startY: number
    curX: number
    curY: number
  } | null>(null)

  // 画面上の表示倍率: 親要素幅にフィット（最大 800px）
  const displayWidth = Math.min(meta.pixelWidth, 800)
  const displayScale = displayWidth / meta.pixelWidth
  const displayHeight = meta.pixelHeight * displayScale

  // px (display) → pt 変換係数
  const pxToPtX = useMemo(
    () => meta.widthPt / meta.pixelWidth,
    [meta.widthPt, meta.pixelWidth],
  )
  const pxToPtY = useMemo(
    () => meta.heightPt / meta.pixelHeight,
    [meta.heightPt, meta.pixelHeight],
  )
  // pt → px (display) は逆 + displayScale 込み（描画用）
  const ptToDispX = useCallback(
    (xPt: number) => (xPt / meta.widthPt) * displayWidth,
    [meta.widthPt, displayWidth],
  )
  const ptToDispY = useCallback(
    (yPt: number) => (yPt / meta.heightPt) * displayHeight,
    [meta.heightPt, displayHeight],
  )

  function clientToDisplay(
    e: React.PointerEvent<HTMLDivElement>,
  ): { x: number; y: number } | null {
    const el = wrapperRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(displayWidth, e.clientX - rect.left)),
      y: Math.max(0, Math.min(displayHeight, e.clientY - rect.top)),
    }
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    // 矩形 (data-box) の上ではドラッグ開始しない
    if (target.closest('[data-box]')) return
    const p = clientToDisplay(e)
    if (!p) return
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    setDrag({ startX: p.x, startY: p.y, curX: p.x, curY: p.y })
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!drag) return
    const p = clientToDisplay(e)
    if (!p) return
    setDrag({ ...drag, curX: p.x, curY: p.y })
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!drag) return
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      // ignore
    }
    const x1 = Math.min(drag.startX, drag.curX)
    const y1 = Math.min(drag.startY, drag.curY)
    const x2 = Math.max(drag.startX, drag.curX)
    const y2 = Math.max(drag.startY, drag.curY)
    setDrag(null)
    const wDisp = x2 - x1
    const hDisp = y2 - y1
    if (wDisp < 4 || hDisp < 4) return // 誤クリック扱い
    // display px → 元画像 px → pt
    const xImg = x1 / displayScale
    const yImg = y1 / displayScale
    const wImg = wDisp / displayScale
    const hImg = hDisp / displayScale
    onAddBox({
      x: xImg * pxToPtX,
      y: yImg * pxToPtY,
      w: wImg * pxToPtX,
      h: hImg * pxToPtY,
    })
  }

  return (
    <div>
      <p className="text-xs text-gray-500 mb-1">ページ {meta.page}</p>
      <div
        ref={wrapperRef}
        className="relative select-none border border-gray-300 bg-gray-100 touch-none"
        style={{ width: displayWidth, height: displayHeight }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl}
            alt={`ページ ${meta.page}`}
            width={displayWidth}
            height={displayHeight}
            draggable={false}
            className="absolute inset-0 w-full h-full pointer-events-none"
          />
        )}

        {boxes.map((b) => {
          const x = ptToDispX(b.bbox.x)
          const y = ptToDispY(b.bbox.y)
          const w = ptToDispX(b.bbox.x + b.bbox.w) - x
          const h = ptToDispY(b.bbox.y + b.bbox.h) - y
          const isSuggestion = b.source === 'auto_suggestion'
          const dismissed = b.dismissed ?? false
          // 白塗り枠を「灰色30%枠」にし記入欄(青)と視覚差別化。
          //   ※当初は白30%枠だったが、白い紙背景に埋もれて見えない実機FBにより灰色系へ変更。
          //   - auto候補（採用中）: 灰色30%破線（border-gray-500 border-dashed bg-gray-400/30）＝候補=未確定の含意
          //   - manual（確定）   : 灰色30%実線（border-gray-600 bg-gray-400/30）
          //   - dismissed（却下） : 塗らない含意なので従来どおり薄グレー破線・透明（塗り色を付けない）
          // 🚨 個人情報死守: この 30%透過は「編集UI上の表示」だけ。実際の焼き込み（出力DL PDF）は
          //    従来どおり estimatedBgColor の不透明白で対象領域を完全被覆する（透過は出力に出ない）。
          const boxClass = isSuggestion
            ? dismissed
              ? 'border-gray-400 border-dashed bg-transparent'
              : 'border-gray-500 border-dashed bg-gray-400/30'
            : 'border-gray-600 bg-gray-400/30'
          return (
            <div
              key={b.id}
              data-box
              className={'absolute border ' + boxClass}
              style={{
                left: x,
                top: y,
                width: Math.max(2, w),
                height: Math.max(2, h),
              }}
              onClick={(e) => {
                e.stopPropagation()
                if (isSuggestion) onToggleSuggestion(b.id)
              }}
              title={
                isSuggestion
                  ? dismissed
                    ? 'クリックで採用'
                    : 'クリックで採用解除'
                  : '右上の × で削除'
              }
            >
              {!isSuggestion && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemoveBox(b.id)
                  }}
                  className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-red-500 text-white text-xs leading-none"
                  aria-label="この矩形を削除"
                >
                  ×
                </button>
              )}
            </div>
          )
        })}

        {drag && (
          <div
            className="absolute border border-gray-700 bg-white/60 pointer-events-none"
            style={{
              left: Math.min(drag.startX, drag.curX),
              top: Math.min(drag.startY, drag.curY),
              width: Math.abs(drag.curX - drag.startX),
              height: Math.abs(drag.curY - drag.startY),
            }}
          />
        )}
      </div>
    </div>
  )
}
