'use client'

/**
 * AdjustView の取得 effect 群（背景 raw PNG / プレビュー用 OTF フォント / pageSizes）を
 * 束ねる custom hook。3 つとも「取得して 1 state を確定するだけ」の独立 effect で、
 * 互いの結果に依存しないため 1 hook に同居させても副作用の絡みは無い。
 *
 * pageSizes は useMinuteAdjustEditor（本体側）の入力でもあるため、呼び出し側は本 hook を
 * editor hook より前に呼ぶこと（順序依存）。
 */
import { useEffect, useState } from 'react'
import type { FittableFont } from '@/lib/pdf-output/fitting'
import { type PageMeta, BUILTIN_SYNTHETIC_A4_PAGE } from '@/lib/pdf-output/bbox-coords'

export interface UseAdjustViewDataParams {
  minuteId: string
  templateId: string
  guestMode?: boolean
  renderImageEndpoint?: string
}

export interface UseAdjustViewDataReturn {
  rawBgUrl: string | null
  pageSizes: PageMeta[]
  previewFont: FittableFont | null
}

export function useAdjustViewData({
  minuteId,
  templateId,
  guestMode,
  renderImageEndpoint,
}: UseAdjustViewDataParams): UseAdjustViewDataReturn {
  const [rawBgUrl, setRawBgUrl] = useState<string | null>(null)
  const [pageSizes, setPageSizes] = useState<PageMeta[]>([])
  // 動的プレビュー用の OTF フォント（opentype.js 経由）。null = ロード未完了 / 失敗 → fallback。
  const [previewFont, setPreviewFont] = useState<FittableFont | null>(null)

  // ── 背景 raw PNG 取得 ─────────────────────────────────────────────────────
  // 通常: /api/minutes/[id]/render-image を raw=true で呼ぶ（記入値ゼロの背景・signedUrl 応答）。
  // guestMode: renderImageEndpoint（既定 /api/guest/render-image）を builtin templateId 付きで
  //   叩く。応答は PNG bytes 直返しのため signedUrl ではなく objectURL 化して使う。
  useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null
    async function load() {
      try {
        if (guestMode) {
          const endpoint = renderImageEndpoint ?? '/api/guest/render-image'
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify({
              templateId,
              content: {},
              overrides: {},
              raw: true,
            }),
          })
          if (!res.ok) return
          const blob = await res.blob()
          if (cancelled) return
          objectUrl = URL.createObjectURL(blob)
          setRawBgUrl(objectUrl)
          return
        }
        const endpoint = renderImageEndpoint ?? `/api/minutes/${minuteId}/render-image`
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify({
            dpi: 150,
            format: 'png',
            pageRange: { from: 1, to: 1 },
            raw: true,
          }),
        })
        if (!res.ok) return
        const json: { signedUrl?: string } = await res.json()
        if (!cancelled && json.signedUrl) setRawBgUrl(json.signedUrl)
      } catch {
        // 背景取得失敗はサイレント（操作は動かす）。
      }
    }
    void load()
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [minuteId, templateId, guestMode, renderImageEndpoint])

  // 動的プレビュー vs PDF 完全一致用の OTF をロード（opentype.js + Noto Sans JP subset を遅延 import）。
  // ロード失敗時は previewFont=null 維持 → fallback（ctx.measureText 経路・劣化プレビュー）。
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const mod = await import('@/lib/parsers/pdf/preview-font-loader')
        const font = await mod.loadPreviewFont()
        if (!cancelled && font) setPreviewFont(font)
      } catch {
        // サイレント fallback（ctx.measureText 経路で UI は動く）。
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // ── pageSizes 取得（templates bbox-editor route を流用・OCR を呼ばない軽量ラスタライズ）──
  // guestMode: 認証必須の bbox-editor route を呼ばず、builtin 固定の A4 ページサイズを即使う
  //   （builtin は source_format !== 'pdf' のため、認証ありで叩いても同じ固定値が返る＝等価）。
  useEffect(() => {
    if (guestMode) {
      setPageSizes([BUILTIN_SYNTHETIC_A4_PAGE])
      return
    }
    let cancelled = false
    async function loadPageSizes() {
      try {
        const res = await fetch(`/api/templates/${templateId}/bbox-editor`, {
          method: 'GET',
          cache: 'no-store',
        })
        if (!res.ok) return
        const json: { pageSizes?: PageMeta[]; editable?: boolean } =
          await res.json()
        if (!cancelled && Array.isArray(json.pageSizes)) {
          setPageSizes(json.pageSizes)
        }
      } catch {
        // pageSizes が取れないと BboxPane は描画されない（フォールバック後述）。
      }
    }
    void loadPageSizes()
    return () => {
      cancelled = true
    }
  }, [templateId, guestMode])

  return { rawBgUrl, pageSizes, previewFont }
}
