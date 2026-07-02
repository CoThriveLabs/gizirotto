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
import { writeFormCache, readFormCache, getSessionStorageSafe } from '@/lib/utils/form-cache'
import {
  guestAdjustDraftFormId,
  GUEST_ADJUST_DRAFT_RESTORE_PATH,
} from '@/lib/utils/guest-adjust-draft'
import { mergeTemplateAndNewFields } from '@/lib/pdf-output/merge-template-and-new-fields'
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

/** save-draft（ログインして保存押下時の退避）の TTL。login/page.tsx との magic-link 往復に十分な 30 分。 */
const GUEST_SNAPSHOT_TTL_MS = 30 * 60 * 1000

interface ResolvedState {
  fields: TemplateFieldDef[]
  pdfFields: PdfField[]
  initialOverrides: BboxOverrides
  initialValues: Record<string, string>
  initialTitle: string
  initialMeetingDate: string
}

/**
 * /minutes/new/adjust?template_id={id} のクライアント側ブートストラップ。
 *
 * AdjustView を guestMode で render する薄いラッパー。mount 時に 2 種類の draft を
 * 優先順位付きで読む（詳細は useEffect 内コメント）:
 *   1. save-draft（`guestAdjustDraftFormId`・保存ボタン押下時に handleGuestSave が書く最新状態）
 *   2. chat-draft（`minutes:guest-chat-draft:{templateId}`・chat 経由 AI 抽出済み content）
 *   3. どちらも無ければサーバ側で組んだ空の initialValues
 *
 * サーバ側 initialValues は SSR と一致させるため空のまま render し、draft の有無判定は
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
  const [resolved, setResolved] = useState<ResolvedState | null>(null)
  // guest 経路の format-item 呼び出しに Turnstile トークンを乗せる中央ゲート。
  // AdjustView が gate.consumeToken() を await → gate.onToken 到着で resolve される。
  const turnstileGate = useGuestTurnstileGate(true)

  const draftConsumedRef = useRef(false)
  useEffect(() => {
    if (draftConsumedRef.current) return
    draftConsumedRef.current = true

    const storage = getSessionStorageSafe()

    // 1. save-draft（保存ボタン押下時の最新状態）を最優先で読む。読み取り専用 — ここで
    //    消費（clearFormCache）してはいけない。ログイン成功後の ManualBootstrap 側の
    //    復元・本保存が draft を消費する唯一の場所であり、ここで消してしまうと
    //    ログイン後に draft が見つからず入力内容が失われる。
    //    expectedPath は「ログイン後の復元先(/minutes/new/manual)」を示す値で
    //    GuestAdjustBootstrap 自身のパスとは意味的に別物のため、ここではチェックしない
    //    （formId が templateId 込みでユニークなため誤読み取りのリスクはない）。
    const saveDraftEntry = readFormCache<GuestMinuteDraft>(
      storage,
      guestAdjustDraftFormId(templateId),
      GUEST_SNAPSHOT_TTL_MS,
    )
    const saveDraft = saveDraftEntry?.values ?? null

    if (saveDraft) {
      const mergedPdfFields = mergeTemplateAndNewFields(pdfFields, saveDraft.newFields ?? [])
      const mergedFields: TemplateFieldDef[] = mergedPdfFields.map((pf) => ({
        name: pf.name,
        label: pf.label,
        bbox: { x: pf.bbox.x, y: pf.bbox.y, w: pf.bbox.w, h: pf.bbox.h },
        multiline: pf.multiline ?? false,
      }))
      setResolved({
        fields: mergedFields,
        pdfFields: mergedPdfFields,
        initialOverrides: saveDraft.overrides,
        initialValues: saveDraft.content,
        initialTitle: saveDraft.title || templateName,
        initialMeetingDate: saveDraft.meetingDate || todayLocal(),
      })
      return
    }

    // 2. save-draft が無ければ chat-draft を試す（既存ロジック、変更なし）。
    //    sessionStorage.getItem → removeItem は非冪等。draftConsumedRef の single-shot
    //    ガードで StrictMode 二重 mount 由来の消費事故を防ぐ（GA2 既知パターン）。
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
    setResolved({
      fields,
      pdfFields,
      initialOverrides,
      initialValues: values,
      initialTitle: templateName,
      initialMeetingDate: todayLocal(),
    })
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

  if (resolved === null) {
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
        initialTitle={resolved.initialTitle}
        initialMeetingDate={resolved.initialMeetingDate}
        fields={resolved.fields}
        pdfFields={resolved.pdfFields}
        initialOverrides={resolved.initialOverrides}
        initialValues={resolved.initialValues}
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
