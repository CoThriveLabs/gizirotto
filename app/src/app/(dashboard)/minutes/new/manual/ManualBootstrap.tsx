'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { createMinute } from '@/server/minutes'
import { useToast } from '@/components/toast/toast-context'
import { LimitModal } from '@/components/usage/limit-modal'
import { ResourceLimitError } from '@/lib/db-error-mapper'
import { useFormCache } from '@/lib/hooks/use-form-cache'

interface Props {
  templateId: string
  templateName: string
  fields: string[]
  /** When true the user is not logged in. createMinute is skipped; save redirects to /login. */
  isGuest?: boolean
}

/** TTL for guest form snapshots (30 min) — long enough for magic-link login round-trip */
const GUEST_SNAPSHOT_TTL_MS = 30 * 60 * 1000

/**
 * /minutes/new/manual?template_id={id} のクライアント側ブートストラップ。
 *
 *   - 認証済み: mount 時に一度だけ Server Action `createMinute(...)` を呼ぶ（useRef ガードで
 *     React 18 StrictMode 二重 mount 対策 = single-shot）
 *     - 成功時: `router.replace('/minutes/{id}/adjust')` で AdjustView へ遷移
 *     - 失敗時: toast.error 表示 + 「テンプレ選択に戻る」リンク表示
 *   - 未ログイン (isGuest=true): createMinute を呼ばず、フィールド入力フォームをそのまま表示。
 *     保存ボタン押下で `/login?next=<currentPath>` へ誘導。
 *
 *   なぜ client から呼ぶか:
 *     createMinute 内部の `revalidatePath('/minutes')` が server component の render 中に
 *     発火すると Next.js が Runtime Error を投げるため。client mount 起点なら抵触しない。
 */
export function ManualBootstrap({ templateId, templateName, fields, isGuest = false }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const { showToast } = useToast()
  const startedRef = useRef(false)
  const [errored, setErrored] = useState(false)
  // 議事録上限到達時の LimitModal 表示状態
  const [limitOpen, setLimitOpen] = useState(false)

  // Guest local-draft state — restored from form-cache on mount if available
  const [guestValues, setGuestValues] = useState<Record<string, string>>(
    () => Object.fromEntries((fields.length === 0 ? ['メモ'] : fields).map((f) => [f, ''])),
  )

  // form-cache for guest draft: 30 min TTL to survive magic-link login round-trip
  const formId = `minutes:new:manual:${templateId}`
  const { saveSnapshot } = useFormCache<Record<string, string>>(formId, {
    ttlMs: GUEST_SNAPSHOT_TTL_MS,
    onRestore: isGuest
      ? (v) => setGuestValues(v)
      : undefined,
  })

  useEffect(() => {
    // Skip createMinute for unauthenticated guests
    if (isGuest) return

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
          /* suppress — no auto-retry to avoid runaway requests */
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

  // --- Guest local-draft mode ---
  if (isGuest) {
    const loginUrl = `/login?next=${encodeURIComponent(pathname ?? '/minutes/new/manual')}`
    const displayFields = fields.length === 0 ? ['メモ'] : fields
    const handleSaveAndLogin = () => {
      // Persist current field values before redirecting to login
      saveSnapshot(guestValues)
    }
    return (
      <div className="max-w-xl mx-auto px-4 py-6 space-y-4">
        <p className="text-xs text-gray-500">
          入力内容を確認してから保存できます。保存にはログインが必要です。
        </p>
        <div className="space-y-3">
          {displayFields.map((fieldName) => (
            <div key={fieldName} className="flex flex-col gap-1">
              <label
                htmlFor={`field-${fieldName}`}
                className="text-sm font-medium text-gray-700"
              >
                {fieldName}
              </label>
              <textarea
                id={`field-${fieldName}`}
                value={guestValues[fieldName] ?? ''}
                onChange={(e) =>
                  setGuestValues((prev) => ({ ...prev, [fieldName]: e.target.value }))
                }
                rows={3}
                className="border border-gizirotto-blue-200 rounded px-3 py-2 text-base resize-none"
              />
            </div>
          ))}
        </div>
        <div className="flex justify-end">
          <Link
            href={loginUrl}
            onClick={handleSaveAndLogin}
            className="inline-flex items-center justify-center rounded bg-gizirotto-blue-700 text-white px-5 py-2 text-sm hover:bg-gizirotto-blue-800"
          >
            ログインして保存する
          </Link>
        </div>
      </div>
    )
  }

  // --- Authenticated bootstrap mode ---
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
