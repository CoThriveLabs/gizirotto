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
import {
  writeFormCache,
  readFormCache,
  clearFormCache,
  getDraftStorageSafe,
  sweepExpiredFormCache,
  GUEST_SNAPSHOT_TTL_MS,
} from '@/lib/utils/form-cache'
import {
  guestAdjustDraftFormId,
  GUEST_ADJUST_DRAFT_RESTORE_PATH,
  guestChatDraftFormId,
  GUEST_CHAT_DRAFT_TTL_MS,
} from '@/lib/utils/guest-adjust-draft'
import { mergeTemplateAndNewFields } from '@/lib/pdf-output/merge-template-and-new-fields'
import { normalizeMeetingDate } from '@/lib/ai/prompts/chat-to-fields'
import { TurnstileWidget } from '@/components/auth/TurnstileWidget'
import { useGuestTurnstileGate } from '@/hooks/useGuestTurnstileGate'
import { GuestLocalStorageNoticeModal } from '@/components/usage/GuestLocalStorageNoticeModal'

/** localStorage 直書き（form-cache 経由にしない）の恒久フラグ。TTL なし・sweep 対象外。 */
const GUEST_LS_NOTICE_SHOWN_KEY = 'minutes:guest-ls-notice-shown'

interface Props {
  templateId: string
  templateName: string
  fields: TemplateFieldDef[]
  pdfFields: PdfField[]
  initialOverrides: BboxOverrides
  initialValues: Record<string, string>
  fixedTextSizesPt?: number[]
}

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
 *   2. chat-draft（`guestChatDraftFormId`・chat 経由 AI 抽出済み content）
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

  // localStorage 残留注意モーダル。draft 復元ロジックとは独立（別 useEffect・別 ref ガード）。
  const [noticeOpen, setNoticeOpen] = useState(false)
  const noticeCheckedRef = useRef(false)
  useEffect(() => {
    if (noticeCheckedRef.current) return
    noticeCheckedRef.current = true
    const storage = getDraftStorageSafe()
    if (!storage) return
    if (storage.getItem(GUEST_LS_NOTICE_SHOWN_KEY)) return
    setNoticeOpen(true)
  }, [])

  function handleNoticeClose() {
    const storage = getDraftStorageSafe()
    storage?.setItem(GUEST_LS_NOTICE_SHOWN_KEY, '1')
    setNoticeOpen(false)
  }

  const draftConsumedRef = useRef(false)
  useEffect(() => {
    if (draftConsumedRef.current) return
    draftConsumedRef.current = true

    const storage = getDraftStorageSafe()
    // sweep の閾値は名前空間内の最大 TTL（save-draft の 30 分）で渡す。5 分固定にすると
    // 30 分 TTL の save-draft がまだ有効なうちに sweep で先に消されてしまう。
    sweepExpiredFormCache(storage, GUEST_SNAPSHOT_TTL_MS)

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

    // 2. save-draft が無ければ chat-draft を試す。ChatView が書くネスト構造
    //    `{ content, meetingDate }` を form-cache 経由で読む。readFormCache が TTL 判定 /
    //    壊れ値の除去まで行うため、ここでは values の取り出しに専念できる。
    //    draftConsumedRef の single-shot ガードで StrictMode 二重 mount 由来の消費事故を防ぐ。
    let values = initialValues
    let chatMeetingDate: string | null = null
    const chatDraftFormId = guestChatDraftFormId(templateId)
    const chatDraftEntry = readFormCache<{
      content?: Record<string, unknown>
      meetingDate?: unknown
    }>(storage, chatDraftFormId, GUEST_CHAT_DRAFT_TTL_MS)
    if (chatDraftEntry) {
      clearFormCache(storage, chatDraftFormId)
      const parsed = chatDraftEntry.values
      const contentObj =
        parsed.content && typeof parsed.content === 'object' ? parsed.content : {}
      const fieldNames = new Set(fields.map((f) => f.name))
      const merged = { ...values }
      // ChatView 側の fields[0] fallback（AI 抽出失敗時、meeting_date のような bbox を
      // 持たない論理フィールドに会話全文を詰める）は、AdjustView 側の fields（bbox 必須）に
      // その名前が存在せず、通常のマージでは握りつぶされる。fields に一致する値が 1 つも
      // 無い場合に限り、一致しなかったキーの最初の非空値を fields[0] へ救済する。
      let unmatchedFallbackValue: string | null = null
      for (const [k, v] of Object.entries(contentObj)) {
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
      // normalizeMeetingDate: YYYY-MM-DD 形式 + 実在日付チェック（chat-to-fields.ts 共有純関数）。
      // ゲスト route / ログイン Server Action と同一ロジックに統一。
      chatMeetingDate = normalizeMeetingDate(parsed.meetingDate) ?? null
    }
    setResolved({
      fields,
      pdfFields,
      initialOverrides,
      initialValues: values,
      initialTitle: templateName,
      initialMeetingDate: chatMeetingDate ?? todayLocal(),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId])

  // useFormCache フックは使わず form-cache.ts の生関数を直接呼ぶ。復元側（ManualBootstrap）は
  // フックの mount タイミングに依存しない同期的な useEffect で読むため、保存側もフック経由の
  // 間接層を挟まず同じ生関数で書く方が経路として素直（フック内部の実行順序に依存しない）。
  function handleGuestSave(draft: GuestMinuteDraft) {
    const storage = getDraftStorageSafe()
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
      <>
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
        <GuestLocalStorageNoticeModal open={noticeOpen} onClose={handleNoticeClose} />
      </>
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
      <GuestLocalStorageNoticeModal open={noticeOpen} onClose={handleNoticeClose} />
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
