'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { createMinute } from '@/server/minutes'
import { useToast } from '@/components/toast/toast-context'
import { LimitModal } from '@/components/usage/limit-modal'
import { ResourceLimitError } from '@/lib/db-error-mapper'

interface Props {
  templateId: string
  templateName: string
  fields: string[]
}

/**
 * /minutes/new/manual?template_id={id} のクライアント側ブートストラップ。
 *
 *   - mount 時に一度だけ Server Action `createMinute(...)` を呼ぶ（useRef ガードで
 *     React 18 StrictMode 二重 mount 対策 = single-shot）
 *   - 成功時: `router.replace('/minutes/{id}/adjust')` で AdjustView へ遷移
 *   - 失敗時: toast.error 表示 + 「テンプレ選択に戻る」リンク表示
 *   - マウント直後〜成功までは「準備中…」spinner + 説明テキスト
 *
 *   なぜ client から呼ぶか:
 *     createMinute 内部の `revalidatePath('/minutes')` が server component の render 中に
 *     発火すると Next.js が Runtime Error を投げるため。client mount 起点なら抵触しない。
 */
export function ManualBootstrap({ templateId, templateName, fields }: Props) {
  const router = useRouter()
  const { showToast } = useToast()
  const startedRef = useRef(false)
  const [errored, setErrored] = useState(false)
  // 議事録上限到達時の LimitModal 表示状態
  const [limitOpen, setLimitOpen] = useState(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true

    const content: Record<string, string> =
      fields.length === 0
        ? { メモ: '' }
        : Object.fromEntries(fields.map((name) => [name, '']))

    ;(async () => {
      try {
        const result = await createMinute({
          templateId,
          title: templateName,
          meetingDate: todayLocal(),
          content,
          sourceMode: 'B-2',
        })
        // builtin 新規作成時に初回サムネ生成を即 trigger（pending → ready へ前倒し）。
        // fire-and-forget: router.replace をブロックしない。失敗時 UI 反映は既存 markFailed 経路に委ねる。
        fetch(`/api/minutes/${result.id}/regenerate-thumbnail`, { method: 'POST' }).catch(() => {
          /* 黙殺・暴走防止のため auto-retry しない */
        })
        router.replace(`/minutes/${result.id}/adjust`)
      } catch (e) {
        console.error('[ManualBootstrap] createMinute failed:', e)
        // 月次上限 (ResourceLimitError) は LimitModal で出し分け。
        // Server Action のシリアライズで instanceof が外れる場合も name + message 一致で判定。
        if (isResourceLimitMinutes(e)) {
          setLimitOpen(true)
          return
        }
        showToast('error', '議事録の準備に失敗しました')
        setErrored(true)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      {/* 議事録月次上限 LimitModal */}
      <LimitModal
        open={limitOpen}
        resource="minutes"
        onClose={() => {
          setLimitOpen(false)
          // 上限の場合はテンプレ選択へ戻す動線が自然
          router.replace('/minutes/new')
        }}
      />
      {errored ? (
        <div className="flex flex-col items-center gap-4 text-center">
          <p className="text-sm text-gray-700">
            議事録の準備に失敗しました。時間をおいて再度お試しください。
          </p>
          <Link
            href="/minutes/new"
            className="inline-flex items-center justify-center rounded border border-gizirotto-blue-300 bg-white px-4 py-2 text-sm text-gizirotto-blue-700 hover:bg-gizirotto-blue-50"
          >
            テンプレ選択に戻る
          </Link>
        </div>
      ) : (
        <div
          role="status"
          aria-live="polite"
          className="flex flex-col items-center gap-3"
        >
          <span
            aria-hidden="true"
            className="inline-block w-8 h-8 border-2 border-gizirotto-blue-200 border-t-gizirotto-blue-600 rounded-full animate-spin"
          />
          <p className="text-sm text-gizirotto-blue-700">準備中…</p>
        </div>
      )}
    </div>
  )
}

function todayLocal(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function isResourceLimitMinutes(e: unknown): boolean {
  if (e instanceof ResourceLimitError) return e.resource === 'minutes'
  if (e instanceof Error) {
    const maybe = e as Error & { resource?: unknown }
    if (
      e.name === 'ResourceLimitError' &&
      e.message === 'RESOURCE_LIMIT_EXCEEDED' &&
      maybe.resource === 'minutes'
    ) {
      return true
    }
  }
  return false
}
