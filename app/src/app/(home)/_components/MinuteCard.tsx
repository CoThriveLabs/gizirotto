'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import type { RecentMinute } from './RecentMinutesSection'

/**
 * 議事録サムネカード。
 *
 * - ready: 従来どおり img 表示
 * - pending: spinner プレースホルダ + on-demand 自動 trigger（useEffect で 1 回 fire）
 * - failed: TemplateCard と同型の「サムネ枠ホバーオーバーレイ」再生成ボタン
 *
 * 自動 trigger 暴走防止:
 *   - 対象は pending のみ（failed は除外・手動ボタンのみ）
 *   - triggeredRef で同一マウント内 1 回保護
 *   - サーバ側 generateMinuteThumbnail 失敗 → 必ず failed 遷移 → 以降自動 trigger 対象外
 */
function formatDate(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

export function MinuteCard({
  minute,
  eager,
}: {
  minute: RecentMinute
  eager: boolean
}) {
  const router = useRouter()
  const triggeredRef = useRef(false)
  const [regenerating, setRegenerating] = useState(false)
  const [regenError, setRegenError] = useState<string | null>(null)

  // pending マウント時に 1 回だけ自動 trigger。
  // failed は対象外（確定的失敗の自動ループを防ぐ）。
  useEffect(() => {
    if (minute.thumbStatus !== 'pending') return
    if (triggeredRef.current) return
    triggeredRef.current = true
    fetch(`/api/minutes/${minute.id}/regenerate-thumbnail`, {
      method: 'POST',
    })
      .then((r) => {
        if (r.ok) router.refresh()
      })
      .catch(() => {
        /* 黙殺・トースト等を出さない（拡大解釈禁止） */
      })
  }, [minute.id, minute.thumbStatus, router])

  async function handleRegenerate(e: React.MouseEvent) {
    // <Link> 内 button の伝播を握る。
    e.preventDefault()
    e.stopPropagation()
    if (regenerating) return
    setRegenerating(true)
    setRegenError(null)
    try {
      const res = await fetch(
        `/api/minutes/${minute.id}/regenerate-thumbnail`,
        { method: 'POST' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.code ?? `HTTP_${res.status}`)
      }
      router.refresh()
    } catch (err) {
      setRegenError(err instanceof Error ? err.message : 'failed')
    } finally {
      setRegenerating(false)
    }
  }

  return (
    <Link
      href={`/minutes/${minute.id}`}
      className="block bg-white border border-[#E5E7EB] rounded-xl shadow-sm overflow-hidden hover:shadow-md transition"
    >
      <div
        className="relative w-full bg-gray-50"
        style={{ aspectRatio: '1 / 1.414' }}
      >
        {minute.thumbStatus === 'ready' && minute.thumbSignedUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={minute.thumbSignedUrl}
            alt={`${minute.title} のサムネ画像`}
            className="absolute inset-0 w-full h-full object-cover"
            loading={eager ? 'eager' : 'lazy'}
            decoding="async"
          />
        ) : minute.thumbStatus === 'pending' ? (
          <PendingPlaceholder />
        ) : (
          <FailedPlaceholder
            regenerating={regenerating}
            regenError={regenError}
            onRegenerate={handleRegenerate}
          />
        )}
      </div>
      <div className="px-3 py-3 space-y-1">
        <p className="text-sm font-medium text-[#1F2937] truncate">
          {minute.title}
        </p>
        <p className="text-xs text-[#9CA3AF]">
          {formatDate(minute.meeting_date)}
        </p>
      </div>
    </Link>
  )
}

/**
 * pending プレースホルダ（spinner + 準備中…）。CSS のみ・lib 追加禁止。
 */
function PendingPlaceholder() {
  return (
    <div
      aria-label="サムネ生成中"
      className="absolute inset-0 bg-gray-100 flex flex-col items-center justify-center gap-2 text-gray-400"
    >
      <span
        aria-hidden="true"
        className="inline-block w-6 h-6 border-2 border-gray-300 border-t-gray-500 rounded-full animate-spin"
      />
      <span className="text-xs">準備中…</span>
    </div>
  )
}

/**
 * failed プレースホルダ。
 * TemplateCard と同デザイン（FileTextIcon 風 + 右下 ! バッジ）+
 * ホバー時に再生成ボタンを表示（PC）。SP はオーバーレイ常時表示。
 */
function FailedPlaceholder({
  regenerating,
  regenError,
  onRegenerate,
}: {
  regenerating: boolean
  regenError: string | null
  onRegenerate: (e: React.MouseEvent) => void
}) {
  return (
    <div className="absolute inset-0 bg-gray-100 flex items-center justify-center text-gray-400 group">
      <svg
        width="32"
        height="32"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
      <span
        className="absolute bottom-2 right-2 bg-red-500 text-white text-xs font-bold rounded-full w-6 h-6 flex items-center justify-center"
        title="サムネ生成に失敗しました"
      >
        !
      </span>
      {/* ホバーオーバーレイ（PC）/ 常時（SP・group-hover が効かない small viewport は md: でガード）。
          現実装は md 未満で常時表示する素直な形にする（拡大解釈禁止・最小実装）。 */}
      <div className="absolute inset-0 flex items-center justify-center opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity bg-black/30">
        <button
          type="button"
          onClick={onRegenerate}
          disabled={regenerating}
          className="text-xs font-medium px-2.5 py-1 rounded bg-white/95 border border-gray-300 text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-50"
        >
          {regenerating ? '生成中…' : '再生成'}
        </button>
      </div>
      {regenError && (
        <span className="absolute bottom-8 left-2 right-2 text-[10px] text-red-600 bg-white/90 rounded px-1 text-center">
          再生成失敗・時間を空けて再試行
        </span>
      )}
    </div>
  )
}
