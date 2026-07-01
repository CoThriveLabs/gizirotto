'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  AdjustView,
  type TemplateFieldDef,
  type GuestMinuteDraft,
} from '@/app/(dashboard)/minutes/[id]/adjust/AdjustView'
import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'
import type { BboxOverrides } from '@/lib/pdf-output/field-override'
import { writeFormCache, getSessionStorageSafe } from '@/lib/utils/form-cache'
import {
  guestAdjustDraftFormId,
  GUEST_ADJUST_DRAFT_RESTORE_PATH,
} from '@/lib/utils/guest-adjust-draft'
import { TurnstileWidget } from '@/components/auth/TurnstileWidget'
import { useGuestTurnstileGate } from '@/hooks/useGuestTurnstileGate'

interface Props {
  templateId: string
  templateName: string
  fields: TemplateFieldDef[]
  pdfFields: PdfField[]
  initialOverrides: BboxOverrides
  initialValues: Record<string, string>
  fixedTextSizesPt?: number[]
}

/**
 * /minutes/new/adjust?template_id={id} のクライアント側ブートストラップ。
 *
 * AdjustView を guestMode で render する薄いラッパー。
 *   - chat 経由（ChatView.onFinalize）が一度きりの sessionStorage キー
 *     `minutes:guest-chat-draft:{templateId}` に AI 抽出済み content を残していれば、
 *     mount 時に 1 回だけ拾って初期値へマージする（読み取り後は即削除）。
 *   - manual 経由は当該キーが無いため、サーバ側で組んだ空の initialValues がそのまま使われる。
 *   - 保存ボタン押下（onGuestSave）は draft を form-cache（sessionStorage）へ退避し /login へ誘導する。
 *     ログイン後の本保存（draft 消費）は別経路の責務。
 *
 * サーバ側 initialValues は SSR と一致させるため空のまま render し、chat draft の有無判定は
 * mount 後の useEffect でのみ行う（hydration mismatch 回避）。
 */
export function GuestAdjustBootstrap({
  templateId,
  templateName,
  fields,
  pdfFields,
  initialOverrides,
  initialValues,
  fixedTextSizesPt,
}: Props) {
  const router = useRouter()
  const [resolvedValues, setResolvedValues] = useState<Record<string, string> | null>(null)
  const [meetingDate] = useState<string>(() => todayLocal())
  // guest 経路の format-item 呼び出しに Turnstile トークンを乗せる中央ゲート。
  // AdjustView が gate.consumeToken() を await → gate.onToken 到着で resolve される。
  const turnstileGate = useGuestTurnstileGate(true)

  // sessionStorage.getItem → removeItem は非冪等（1 回目で消費してしまう）。React 18 StrictMode の
  // 二重 mount（mount → cleanup → 再 mount）で 1 回目の実行が chat-draft キーを消してしまうと、
  // 実際にコミットされる 2 回目の実行では既に空で、AI 抽出済み content が丸ごと失われる。
  // use-form-cache.ts の restoredRef と同じ single-shot ガードで吸収する。
  const draftConsumedRef = useRef(false)
  useEffect(() => {
    if (draftConsumedRef.current) return
    draftConsumedRef.current = true

    let values = initialValues
    try {
      const key = `minutes:guest-chat-draft:${templateId}`
      const raw = sessionStorage.getItem(key)
      if (raw) {
        sessionStorage.removeItem(key)
        const parsed = JSON.parse(raw) as Record<string, unknown>
        const fieldNames = new Set(fields.map((f) => f.name))
        const merged = { ...values }
        // ChatView 側の fields[0] fallback（AI 抽出失敗時、meeting_date のような bbox を
        // 持たない論理フィールドに会話全文を詰める）は、AdjustView 側の fields（bbox 必須）に
        // その名前が存在せず、通常のマージでは握りつぶされる。fields に一致する値が 1 つも
        // 無い場合に限り、一致しなかったキーの最初の非空値を fields[0] へ救済する。
        let unmatchedFallbackValue: string | null = null
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v !== 'string') continue
          if (fieldNames.has(k)) {
            merged[k] = v
          } else if (unmatchedFallbackValue === null && v.trim() !== '') {
            unmatchedFallbackValue = v
          }
        }
        const hasAnyMatchedValue = fields.some((f) => (merged[f.name] ?? '').trim() !== '')
        if (!hasAnyMatchedValue && unmatchedFallbackValue !== null && fields.length > 0) {
          merged[fields[0].name] = unmatchedFallbackValue
        }
        values = merged
      }
    } catch {
      // 壊れた draft は無視し空初期値のまま続行する。
    }
    setResolvedValues(values)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId])

  // useFormCache フックは使わず form-cache.ts の生関数を直接呼ぶ。復元側（ManualBootstrap）は
  // フックの mount タイミングに依存しない同期的な useEffect で読むため、保存側もフック経由の
  // 間接層を挟まず同じ生関数で書く方が経路として素直（フック内部の実行順序に依存しない）。
  function handleGuestSave(draft: GuestMinuteDraft) {
    const storage = getSessionStorageSafe()
    writeFormCache(
      storage,
      guestAdjustDraftFormId(templateId),
      draft,
      GUEST_ADJUST_DRAFT_RESTORE_PATH,
    )
    const next = `/minutes/new/adjust?template_id=${templateId}`
    router.push(`/login?next=${encodeURIComponent(next)}`)
  }

  if (resolvedValues === null) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex flex-col items-center gap-3 py-12"
      >
        <span
          aria-hidden="true"
          className="inline-block w-8 h-8 border-2 border-gizirotto-blue-200 border-t-gizirotto-blue-600 rounded-full animate-spin"
        />
        <p className="text-sm text-gizirotto-blue-700">準備中…</p>
      </div>
    )
  }

  return (
    <>
      <AdjustView
        minuteId="guest"
        templateId={templateId}
        initialTitle={templateName}
        initialMeetingDate={meetingDate}
        fields={fields}
        pdfFields={pdfFields}
        initialOverrides={initialOverrides}
        initialValues={resolvedValues}
        fixedTextSizesPt={fixedTextSizesPt}
        guestMode
        renderImageEndpoint="/api/guest/render-image"
        onGuestSave={handleGuestSave}
        guestTurnstileGate={turnstileGate}
      />
      {/* Invisible Turnstile。format-item のゲート専用。onToken は gate 経由で AdjustView へ届く。 */}
      <TurnstileWidget
        ref={(w) => turnstileGate.bindWidget(w)}
        onToken={turnstileGate.onToken}
      />
    </>
  )
}

function todayLocal(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
