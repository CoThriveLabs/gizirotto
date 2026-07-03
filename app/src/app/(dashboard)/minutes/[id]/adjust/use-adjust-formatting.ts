'use client'

/**
 * 整形 SSE（ManualForm.onFormat 移植）を束ねる custom hook。
 *
 * tones / customTexts は onFormat が読み、Inspector（renderInspector・本体側）が setter を使う
 * 共有 state だが、onFormat と同居させるのが自然なためこの hook が保持し、本体が受け取って
 * renderInspector へ渡す（1 つの hook に凝集して注入ゼロ）。
 */
import { useState } from 'react'
import { parseSseStream } from '@/lib/utils/sse-stream'
import type { UseGuestTurnstileGate } from '@/hooks/useGuestTurnstileGate'
import type { UseMinuteAdjustEditor } from '@/hooks/editor/useMinuteAdjustEditor'
import { type Tone, type TemplateFieldDef } from './adjust-view-helpers'

export interface UseAdjustFormattingParams {
  editor: UseMinuteAdjustEditor
  guestTurnstileGate?: UseGuestTurnstileGate
  setErrorMsg: (msg: string | null) => void
  initialFields: TemplateFieldDef[]
}

export interface UseAdjustFormattingReturn {
  tones: Record<string, Tone>
  setTones: React.Dispatch<React.SetStateAction<Record<string, Tone>>>
  customTexts: Record<string, string>
  setCustomTexts: React.Dispatch<React.SetStateAction<Record<string, string>>>
  formatting: string | null
  onFormat: (name: string) => Promise<void>
}

export function useAdjustFormatting({
  editor,
  guestTurnstileGate,
  setErrorMsg,
  initialFields,
}: UseAdjustFormattingParams): UseAdjustFormattingReturn {
  const [tones, setTones] = useState<Record<string, Tone>>(() =>
    Object.fromEntries(initialFields.map((f) => [f.name, 'omakase' as Tone])),
  )
  const [customTexts, setCustomTexts] = useState<Record<string, string>>(() =>
    Object.fromEntries(initialFields.map((f) => [f.name, ''])),
  )
  const [formatting, setFormatting] = useState<string | null>(null)

  function labelOf(name: string): string {
    return editor.fields.find((f) => f.name === name)?.label ?? name
  }

  // 🚨 #19 差し戻し対応と同様の理由で useCallback にしない（通常関数）。
  //   メモ化すると古いクロージャで最新 editor/tones/customTexts を握れず取りこぼす。
  async function onFormat(name: string) {
    const raw = editor.values[name]?.trim()
    if (!raw) {
      setErrorMsg(`${labelOf(name)} に内容を入力してから整形してください`)
      return
    }
    if (tones[name] === 'custom' && !customTexts[name]?.trim()) {
      setErrorMsg('整え方「自由」の指示を入力してください')
      return
    }
    setFormatting(name)
    setErrorMsg(null)
    editor.pushUndoOther(name)
    try {
      // guest 時のみ Turnstile トークンを await。gate 未指定（ログインユーザー）は undefined 即
      // return なので、body に turnstileToken フィールドは一切乗らない（回帰テスト対象）。
      const capturedToken = guestTurnstileGate
        ? await guestTurnstileGate.consumeToken()
        : undefined
      const res = await fetch('/api/minutes/format-item', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          field_name: name,
          raw_text: raw,
          tone: tones[name],
          ...(tones[name] === 'custom'
            ? { custom_text: customTexts[name].trim() }
            : {}),
          ...(capturedToken !== undefined ? { turnstileToken: capturedToken } : {}),
        }),
      })
      if (!res.ok || !res.body) {
        // 失敗時は次回チャレンジを明示発火（gate 未指定なら no-op）。
        guestTurnstileGate?.reset()
        throw new Error('FORMAT_FAILED')
      }
      let accumulated = ''
      let receivedAny = false
      await parseSseStream(res.body, (text) => {
        if (!receivedAny) {
          accumulated = ''
          receivedAny = true
        }
        accumulated += text
        editor.setValues((prev) => ({ ...prev, [name]: accumulated }))
      })
      if (!receivedAny) throw new Error('NO_OUTPUT')
      // 成功時: 次回チャレンジ発火（Cloudflare 仕様上明示 reset が必要）。gate 未指定
      // （ログインユーザー経路）は no-op なので body への影響は無い。
      guestTurnstileGate?.reset()
    } catch {
      setErrorMsg('整形に失敗しました。少し時間を置いて再度お試しください。')
    } finally {
      setFormatting(null)
    }
  }

  return { tones, setTones, customTexts, setCustomTexts, formatting, onFormat }
}
