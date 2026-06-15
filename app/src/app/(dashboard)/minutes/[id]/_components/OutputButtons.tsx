'use client'

import Link from 'next/link'
import { useState } from 'react'
import ImagePreviewButton from '@/components/image-preview/image-preview-button'
import { containsJapanese, humanizeErrorCode } from '@/lib/errors/user-message'

interface Props {
  minuteId: string
  title: string
  sourceFormat: string | null
}

/**
 * 出力ボタン群（§28-4 + §29-4 D-14 fallback）。
 * - 「Word でダウンロード」: /api/minutes/[id]/output/docx (§1-7)
 * - 「PDF でダウンロード」: /api/minutes/[id]/output/pdf (§1-8)
 * - 「画像で見る/DL」: render-image dpi 300（既存）
 *
 * D-14 fallback: PDF route が BLANK_PDF_FAILED / TEMPLATE_HAS_NO_FIELDS 等 fallback=true を返したら
 * 3 択 modal（再アップ / レイアウトなし出力（Phase 6+）/ デフォルト代用（Phase 6+））を表示。
 */
export function OutputButtons({ minuteId, title, sourceFormat }: Props) {
  const [downloading, setDownloading] = useState<'docx' | 'pdf' | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [fallbackOpen, setFallbackOpen] = useState(false)
  const [fallbackMsg, setFallbackMsg] = useState<string | null>(null)

  async function onDownload(format: 'docx' | 'pdf') {
    setDownloading(format)
    setErrorMsg(null)
    setFallbackOpen(false)
    try {
      const res = await fetch(`/api/minutes/${minuteId}/output/${format}`, {
        method: 'POST',
      })
      if (!res.ok) {
        const body: { fallback?: boolean; message?: string } = await res
          .json()
          .catch(() => ({}))
        if (body.fallback && format === 'pdf') {
          setFallbackMsg(body.message ?? null)
          setFallbackOpen(true)
          return
        }
        throw new Error(body.message ?? 'OUTPUT_FAILED')
      }
      const json: { downloadUrl?: string } = await res.json()
      if (!json.downloadUrl) throw new Error('OUTPUT_FAILED')
      window.open(json.downloadUrl, '_blank', 'noopener,noreferrer')
    } catch (e) {
      // サーバ message が日本語（pdf route の親切文）ならそのまま。英文/コードは humanize。
      // message 無し（OUTPUT_FAILED）は従来どおり形式別の固定文へ。
      const serverMsg =
        e instanceof Error && e.message && !e.message.includes('OUTPUT_FAILED')
          ? e.message
          : null
      setErrorMsg(
        serverMsg
          ? containsJapanese(serverMsg)
            ? serverMsg
            : humanizeErrorCode(serverMsg).message
          : format === 'docx'
            ? 'Word のダウンロードに失敗しました。少し時間を置いて再度お試しください。'
            : 'PDF のダウンロードに失敗しました。少し時間を置いて再度お試しください。',
      )
    } finally {
      setDownloading(null)
    }
  }

  return (
    <div className="flex flex-col gap-2 items-end">
      <div className="flex flex-wrap gap-2 justify-end">
        <button
          type="button"
          onClick={() => onDownload('docx')}
          disabled={downloading !== null}
          className="text-sm border border-gizirotto-blue-300 text-gizirotto-blue-700 px-3 py-2 rounded hover:bg-gizirotto-blue-50 disabled:opacity-50"
        >
          {downloading === 'docx' ? '準備中…' : 'Word でダウンロード'}
        </button>
        <button
          type="button"
          onClick={() => onDownload('pdf')}
          disabled={downloading !== null}
          className="text-sm border border-gizirotto-blue-300 text-gizirotto-blue-700 px-3 py-2 rounded hover:bg-gizirotto-blue-50 disabled:opacity-50"
        >
          {downloading === 'pdf' ? '準備中…' : 'PDF でダウンロード'}
        </button>
        {sourceFormat === 'pdf' && (
          <ImagePreviewButton
            apiEndpoint={`/api/minutes/${minuteId}/render-image`}
            buttonLabel="画像で見る/DL"
            modalTitle={`${title} の画像プレビュー`}
            showDownloadButton
            downloadFileName={`${title || 'minutes'}.png`}
            variant="secondary"
          />
        )}
      </div>
      {errorMsg && (
        <p className="text-xs text-red-600 max-w-xs text-right" role="alert">
          {errorMsg}
        </p>
      )}

      {fallbackOpen && (
        <div
          role="dialog"
          aria-labelledby="fallback-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setFallbackOpen(false)}
        >
          <div
            className="bg-white rounded-lg shadow-lg max-w-md w-full p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="fallback-title" className="text-base font-medium text-gizirotto-blue-900">
              PDF が作れませんでした
            </h3>
            <p className="text-sm text-gray-700">
              {fallbackMsg ?? 'テンプレに問題があるようです。どうしますか？'}
            </p>
            <ul className="space-y-2 text-sm">
              <li>
                <Link
                  href="/templates"
                  className="block px-3 py-2 border border-gizirotto-blue-200 rounded hover:bg-gizirotto-blue-50"
                  onClick={() => setFallbackOpen(false)}
                >
                  テンプレを再アップロードする
                </Link>
              </li>
              <li>
                <button
                  type="button"
                  disabled
                  className="block w-full text-left px-3 py-2 border border-gizirotto-blue-100 rounded text-gray-400 cursor-not-allowed"
                  title="今後のアップデートで利用できるようになります"
                >
                  レイアウトなしで出力する
                  <span className="block text-xs">（今後のアップデートで対応予定）</span>
                </button>
              </li>
              <li>
                <button
                  type="button"
                  disabled
                  className="block w-full text-left px-3 py-2 border border-gizirotto-blue-100 rounded text-gray-400 cursor-not-allowed"
                  title="今後のアップデートで利用できるようになります"
                >
                  デフォルトテンプレで出力する
                  <span className="block text-xs">（今後のアップデートで対応予定）</span>
                </button>
              </li>
            </ul>
            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={() => setFallbackOpen(false)}
                className="text-sm text-gray-600 hover:text-gray-800 px-3 py-1"
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
