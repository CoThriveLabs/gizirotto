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

import { useEffect, useState } from 'react'
import ErrorNotice from '@/components/error-notice'
import { humanizeErrorCode } from '@/lib/errors/user-message'
import type { RgbColor, WhiteoutBox, PageMeta, BoxState } from './whiteout-modal-types'
import { PagePane } from './whiteout-page-pane'

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
