'use client'

import { useCallback, useEffect, useState } from 'react'
import { useToast } from '@/components/toast/toast-context'
import { humanizeErrorCode } from '@/lib/errors/user-message'
import {
  maybeNotifyImageAdjusted,
  type RenderImageApiResponse,
} from '@/components/toast/dpi-downgrade-toast'

/**
 * 「画像で見る」ボタン + モーダルプレビュー（T-E-2 / T-E-4 汎用）。
 *
 * - apiEndpoint: 議事録なら /api/minutes/[id]/render-image、テンプレなら /api/templates/[id]/render-image
 * - showDownloadButton: モーダル内に「画像を保存」リンクを表示するか
 * - buttonLabel: ボタン表示テキスト（既定: 画像で見る）
 *
 * 画質設定は固定（既定 150）で、ユーザーに dpi 等の専門用語は見せない。
 */
export interface ImagePreviewButtonProps {
  apiEndpoint: string
  buttonLabel?: string
  modalTitle?: string
  showDownloadButton?: boolean
  downloadFileName?: string
  variant?: 'primary' | 'secondary'
}

interface PreviewState {
  loading: boolean
  signedUrl: string | null
  error: string | null
}

const INITIAL: PreviewState = {
  loading: false,
  signedUrl: null,
  error: null,
}

export default function ImagePreviewButton({
  apiEndpoint,
  buttonLabel = '画像で見る',
  modalTitle = '画像プレビュー',
  showDownloadButton = true,
  downloadFileName = 'image.png',
  variant = 'primary',
}: ImagePreviewButtonProps) {
  const { showToast } = useToast()
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<PreviewState>(INITIAL)

  const fetchImage = useCallback(async () => {
    setState({ loading: true, signedUrl: null, error: null })
    try {
      const res = await fetch(apiEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const json: RenderImageApiResponse & { error?: string } = await res
        .json()
        .catch(() => ({}) as RenderImageApiResponse)
      if (!res.ok) {
        const msg = humanizeErrorCode(json?.error).message
        setState({ loading: false, signedUrl: null, error: msg })
        showToast('error', msg)
        return
      }
      maybeNotifyImageAdjusted(json, showToast)
      setState({
        loading: false,
        signedUrl: json.signedUrl ?? null,
        error: json.signedUrl ? null : '画像の URL を取得できませんでした',
      })
    } catch (e) {
      const msg = humanizeErrorCode(e instanceof Error ? e.message : null).message
      setState({ loading: false, signedUrl: null, error: msg })
      showToast('error', msg)
    }
  }, [apiEndpoint, showToast])

  const handleOpen = useCallback(() => {
    setOpen(true)
    if (!state.signedUrl && !state.loading) {
      void fetchImage()
    }
  }, [fetchImage, state.loading, state.signedUrl])

  const handleClose = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const btnClass =
    variant === 'primary'
      ? 'bg-gizirotto-blue-500 hover:bg-gizirotto-blue-700 text-white text-sm px-4 py-2 rounded'
      : 'border border-gizirotto-blue-300 text-gizirotto-blue-800 hover:bg-gizirotto-blue-50 text-sm px-3 py-1.5 rounded'

  return (
    <>
      <button type="button" onClick={handleOpen} className={btnClass}>
        {buttonLabel}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={modalTitle}
          onClick={handleClose}
        >
          <div
            className="bg-white rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center justify-between border-b border-gizirotto-blue-100 px-4 py-3">
              <h2 className="text-base font-medium text-gizirotto-blue-900">
                {modalTitle}
              </h2>
              <button
                type="button"
                onClick={handleClose}
                aria-label="閉じる"
                className="text-gray-500 hover:text-gray-800 text-xl leading-none"
              >
                ×
              </button>
            </header>

            <div className="flex-1 overflow-auto p-4 bg-gizirotto-blue-50/40">
              {state.loading && (
                <div className="text-center text-sm text-gray-600 py-12">
                  画像を作成中です…（数秒〜十数秒かかる場合があります）
                </div>
              )}
              {state.error && !state.loading && (
                <div className="text-center text-sm text-red-600 py-12 space-y-3">
                  <p>{state.error}</p>
                  <button
                    type="button"
                    onClick={fetchImage}
                    className="border border-gizirotto-blue-300 text-gizirotto-blue-800 hover:bg-gizirotto-blue-50 px-3 py-1.5 rounded text-xs"
                  >
                    もう一度試す
                  </button>
                </div>
              )}
              {state.signedUrl && !state.loading && !state.error && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={state.signedUrl}
                  alt={modalTitle}
                  className="max-w-full h-auto mx-auto rounded shadow-sm bg-white"
                />
              )}
            </div>

            {showDownloadButton && state.signedUrl && (
              <footer className="border-t border-gizirotto-blue-100 px-4 py-3 flex justify-end gap-2">
                <a
                  href={state.signedUrl}
                  download={downloadFileName}
                  className="bg-gizirotto-blue-500 hover:bg-gizirotto-blue-700 text-white text-sm px-4 py-2 rounded"
                >
                  画像を保存
                </a>
              </footer>
            )}
          </div>
        </div>
      )}
    </>
  )
}
