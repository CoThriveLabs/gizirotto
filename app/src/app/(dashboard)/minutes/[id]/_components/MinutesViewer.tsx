'use client'

import { useEffect, useState } from 'react'
import { ZoomPanel } from '@/components/editor/ZoomPanel'

interface Props {
  minuteId: string
  title: string
  thumbnailStatus: string
}

/**
 * 議事録 viewer（§28-1 / §28-5）。dpi 150 PNG を render-image API 経由で取得 → <img> 表示。
 * 複数ページ対応: page=1 から順に取得、404 / 失敗時は終了 = 単一ページ前提のテンプレで安全に動く。
 * LCP < 1.5 秒目標 = 1 ページ目を最優先で取得 + 後続ページは並列で fetch。
 *
 * ZoomPanel + zoom state:
 *   - プレビュー <img> に transform: scale(zoom) 適用（top left 起点）
 *   - ZoomPanel は AdjustView / templates と同型コピー実装
 *   - 後日リファクタリングで共有コンポーネント化予定
 */
export function MinutesViewer({ minuteId, title, thumbnailStatus }: Props) {
  const [pages, setPages] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  // zoom state（既定 1.0 = 等倍）。
  const [zoom, setZoom] = useState(1)

  useEffect(() => {
    let cancelled = false

    async function loadPages() {
      setLoading(true)
      setErrorMsg(null)
      try {
        // 1 ページ目のみ fetch（複数ページ対応は templates.page_count 連携時に再導入）。
        // 旧 page=1..10 ループは重い render-image を最大 10 回叩く副作用があり、
        // N-1 二次バグ（保存 1 回で 10 リクエスト発火）の原因になっていた。
        const res = await fetch(`/api/minutes/${minuteId}/render-image`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify({
            dpi: 150,
            format: 'png',
            pageRange: { from: 1, to: 1 },
          }),
        })
        if (cancelled) return
        if (!res.ok) {
          setErrorMsg('画像を表示できませんでした')
        } else {
          const json: { signedUrl?: string } = await res.json()
          if (json.signedUrl) {
            setPages([json.signedUrl])
          } else {
            setErrorMsg('画像を表示できませんでした')
          }
        }
      } catch {
        if (!cancelled) setErrorMsg('画像を表示できませんでした')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void loadPages()
    return () => {
      cancelled = true
    }
  }, [minuteId])

  return (
    <section className="space-y-3">
      {thumbnailStatus !== 'ready' && pages.length === 0 && (
        <p className="text-xs text-gray-500">
          画像を準備しています。少し時間がかかることがあります。
        </p>
      )}
      {loading && pages.length === 0 && (
        <div className="bg-gizirotto-blue-50 border border-gizirotto-blue-100 rounded p-8 text-center text-sm text-gray-500">
          読み込み中…
        </div>
      )}
      {errorMsg && (
        <p className="text-sm text-red-600" role="alert">
          {errorMsg}
        </p>
      )}
      {/* §2-D7 (D9・ユーザー実機フィードバック 2026-06-09): zoom 拡大時に横スクロールが出るよう、
          templates `bbox-pane.tsx` L551 同パターン (`overflow-auto` 親 + 内側 `flex justify-center min-w-min`)
          を踏襲。transform: scale は実 box サイズを変えず横 overflow を発生させないため、
          img の width を `${zoom * 100}%` に変更（実 box が拡大 → scroll-container の自然 width
          も拡大 → overflow-x-auto が機能）。transform 起点は廃止し width スケールに統一。 */}
      <div className="space-y-3 overflow-auto">
        <div className="flex justify-center min-w-min">
          <div className="space-y-3" style={{ width: `${zoom * 100}%` }}>
            {pages.map((src, i) => (
              // next/image だと signed URL の domain whitelist 必要なので素の img タグ採用、
              // viewer は authenticated routes 配下 = SEO 影響なし。
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={i}
                src={src}
                alt={`${title} ${pages.length > 1 ? `${i + 1} ページ目` : ''}`.trim()}
                className="w-full bg-white border border-gizirotto-blue-100 rounded shadow-sm"
                loading={i === 0 ? 'eager' : 'lazy'}
                data-testid="minutes-viewer-img"
              />
            ))}
          </div>
        </div>
      </div>

      {/* ZoomPanel（AdjustView / templates と同型コピー）。
          配置: 右下固定（templates ZoomPanel と同じ bottom-2 md:bottom-4 right-3）。
          詳細画面の他 UI（OutputButtons は header 右上 / MinutesActions は viewer 下）と重ならない。 */}
      {pages.length > 0 && <ZoomPanel zoom={zoom} onZoom={setZoom} />}
    </section>
  )
}

