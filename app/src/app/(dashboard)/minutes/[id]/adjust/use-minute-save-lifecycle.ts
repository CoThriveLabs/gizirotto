'use client'

/**
 * AdjustView の保存ライフサイクル（本保存 / 離脱ガードの保存・破棄）を束ねる custom hook。
 *
 * router / showToast は hook 内で直接取得する（呼出側からの注入不要）。
 *
 * 🚨 #19 差し戻し対応と同型: onSave / handleLeaveSaveAndBack / handleLeaveDiscardAndBack は
 *   useCallback にしない（通常関数）。メモ化すると古いクロージャで最新 title/meetingDate/dirty
 *   を握れず保存が取りこぼされるバグになる。
 */
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { saveMinuteAdjust, updateMinute } from '@/server/minutes'
import type { BboxOverrides } from '@/lib/pdf-output/field-override'
import type { PdfField } from '@/lib/ai/schemas/pdf-field-schema'
import { useToast } from '@/components/toast/toast-context'
import type { GuestMinuteDraft } from './AdjustView'

export interface UseMinuteSaveLifecycleParams {
  minuteId: string
  templateId: string
  guestMode?: boolean
  onGuestSave?: (draft: GuestMinuteDraft) => void
  title: string
  meetingDate: string
  metaDirty: boolean
  buildSavePayload: () => {
    content: Record<string, string>
    overrides: BboxOverrides
    newFields?: PdfField[]
  }
  setErrorMsg: (msg: string | null) => void
}

export interface UseMinuteSaveLifecycleReturn {
  saving: boolean
  firstSaveConsumed: boolean
  leaveGuardOpen: boolean
  leaveSaving: boolean
  leaveSaveError: string | null
  onSave: () => Promise<void>
  handleLeaveSaveAndBack: () => Promise<void>
  handleLeaveDiscardAndBack: () => void
  openLeaveGuard: () => void
  closeLeaveGuard: () => void
}

type PersistResult =
  | { ok: true }
  | { ok: false; userMessage: string; cause: unknown }

export function useMinuteSaveLifecycle({
  minuteId,
  templateId,
  guestMode,
  onGuestSave,
  title,
  meetingDate,
  metaDirty,
  buildSavePayload,
  setErrorMsg,
}: UseMinuteSaveLifecycleParams): UseMinuteSaveLifecycleReturn {
  const router = useRouter()
  const { showToast } = useToast()

  const [saving, setSaving] = useState(false)
  // ログインユーザーの AdjustView 初回表示時、DB は createMinute 済みで dirty=false だが、
  // 「一度は能動的に保存を完了できる」UX のため保存ボタンを活性にしておく。初回保存を
  // 押したら true にし、以降は通常の dirty 連動へ戻す。guestMode では使わない。
  const [firstSaveConsumed, setFirstSaveConsumed] = useState(false)
  // 「閲覧画面に戻る」未保存ガードモーダル (bbox-editor と同型・共通モーダル経由)。
  const [leaveGuardOpen, setLeaveGuardOpen] = useState(false)
  const [leaveSaving, setLeaveSaving] = useState(false)
  const [leaveSaveError, setLeaveSaveError] = useState<string | null>(null)

  /**
   * 議事録保存（記入欄 + meta）を 1 関数に集約。
   *   - バリデーション（title 必須・meetingDate YYYY-MM-DD）
   *   - editor.buildSavePayload() → saveMinuteAdjust
   *   - metaDirty 時のみ updateMinute（順序固定: saveMinuteAdjust 後）
   *
   * エラーは throw せず PersistResult で返す。呼出側は ok=true 時に router.push、
   * ok=false 時に固有の error state へ userMessage を入れる。これにより onSave() は
   * トースト + 画面エラー、モーダル経路はモーダル内 error と振り分けを呼出側に閉じ込められる。
   */
  async function persistMinute(): Promise<PersistResult> {
    if (!title.trim()) {
      return { ok: false, userMessage: 'タイトルを入力してください', cause: 'VALIDATION_TITLE' }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(meetingDate)) {
      return { ok: false, userMessage: '開催日を入力してください', cause: 'VALIDATION_DATE' }
    }
    try {
      // newFields は 1 件以上のときだけ payload に含む（hook の buildSavePayload で構築）。
      // 0 件: saveMinuteAdjust.newFields=undefined で既存 new_fields を保持。
      const payload = buildSavePayload()
      await saveMinuteAdjust({
        id: minuteId,
        content: payload.content,
        overrides: payload.overrides,
        newFields: payload.newFields,
      })
      // タイトル / 開催日に変更があれば updateMinute で別途保存。
      //   - content は送らないため updateMinute 内 regenerate は走らない。
      //   - saveMinuteAdjust が成功した後に呼ぶ（順序逆だと title 失敗時に content だけ保存される）。
      if (metaDirty) {
        await updateMinute({
          id: minuteId,
          title: title.trim(),
          meetingDate,
        })
      }
      return { ok: true }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[AdjustView.persistMinute] failed:', e)
      const userMessage = msg === 'MINUTE_UPDATE_NOT_PERSISTED'
        ? '保存できませんでした。もう一度お試しいただき、続く場合は再ログインしてください。'
        : '保存に失敗しました。少し時間を置いて再度お試しください。'
      return { ok: false, userMessage, cause: e }
    }
  }

  /** guestMode 保存ボタンが onGuestSave へ渡す draft を組み立てる。DB へは一切触れない。 */
  function buildGuestDraft(): GuestMinuteDraft {
    const payload = buildSavePayload()
    return {
      templateId,
      title: title.trim(),
      meetingDate,
      content: payload.content,
      overrides: payload.overrides,
      newFields: payload.newFields,
    }
  }

  async function onSave() {
    if (guestMode) {
      onGuestSave?.(buildGuestDraft())
      return
    }
    // 初回保存アクションを消費。保存成功時は router.push で遷移するので、この state が
    // 非活性へ戻す効果は「保存失敗で画面に留まった稀ケース」に効くガード。
    setFirstSaveConsumed(true)
    setSaving(true)
    setErrorMsg(null)
    const result = await persistMinute()
    if (result.ok) {
      router.push(`/minutes/${minuteId}`)
      return
    }
    // 保存失敗時は firstSaveConsumed を戻し、未編集のまま即座に再試行できるようにする
    // （立てたままだと 1 文字編集かリロードでしか保存ボタンが復帰しない）。
    setFirstSaveConsumed(false)
    setErrorMsg(result.userMessage)
    // バリデーション失敗（API 未到達）ではトーストを出さず画面エラーのみ。
    // 既存挙動を維持するため API 失敗時のみトースト発火。
    if (result.cause !== 'VALIDATION_TITLE' && result.cause !== 'VALIDATION_DATE') {
      showToast('error', result.userMessage)
    }
    setSaving(false)
  }

  /**
   * モーダル「保存して移動」。
   * guestMode: persistMinute は UNAUTHENTICATED で必ず失敗するため onSave と同じ分岐で
   *   onGuestSave に差し替える。form-cache 退避 + /login 遷移は呼出側（GuestAdjustBootstrap）の
   *   責務なので、ここではモーダルを閉じるだけでよい。
   * 通常: 同じ persistMinute() を呼び、結果をモーダル内 error に振り分け。
   */
  async function handleLeaveSaveAndBack() {
    if (guestMode) {
      setLeaveGuardOpen(false)
      onGuestSave?.(buildGuestDraft())
      return
    }
    setLeaveSaving(true)
    setLeaveSaveError(null)
    const result = await persistMinute()
    if (result.ok) {
      setLeaveGuardOpen(false)
      router.push(`/minutes/${minuteId}`)
      return
    }
    // モーダルに留まり、モーダル内 error にのみ表示（トースト・画面エラーは出さない）。
    setLeaveSaveError(result.userMessage)
    setLeaveSaving(false)
  }

  /**
   * モーダル「保存せず移動」: 未保存を破棄して戻る。
   * guestMode はゲストが保存済み minute を持たず「閲覧画面」に相当する行き先が無いため、
   * テンプレ選択画面（/templates・未ログインでもアクセス可）へ戻す。
   */
  function handleLeaveDiscardAndBack() {
    setLeaveGuardOpen(false)
    router.push(guestMode ? '/templates' : `/minutes/${minuteId}`)
  }

  function openLeaveGuard() {
    setLeaveSaveError(null)
    setLeaveGuardOpen(true)
  }

  function closeLeaveGuard() {
    setLeaveGuardOpen(false)
  }

  return {
    saving,
    firstSaveConsumed,
    leaveGuardOpen,
    leaveSaving,
    leaveSaveError,
    onSave,
    handleLeaveSaveAndBack,
    handleLeaveDiscardAndBack,
    openLeaveGuard,
    closeLeaveGuard,
  }
}
