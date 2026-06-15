'use client'

/**
 * 固定テキストレイヤの編集ロジック。useLayerEditor<FixedTextMeta> を包む薄いラッパ。
 *
 * 総称 hook（useLayerEditor）が持たない固定テキスト固有のみ追加する:
 *   - fixedSizeStep  : font.size を ±delta して bbox.h/w を再算出（大きさボタン）
 *   - fixedValueChange: value 入力 + 1 秒窓 coalesce（lastFixedValueEditRef は内部閉じ込め）
 *   - fixedTextValueOf: meta.value を解決（bbox-pane の fit-to-box プレビュー用）
 *   - onKeyDown      : 矢印=移動のみ（Shift+矢印リサイズなし・固定テキスト固有）
 *   - save           : updateTemplateFixedTexts + commitSaved + refetchBackgrounds
 *
 * 不変条件（設計書 §3-3）:
 *   lastFixedValueEditRef は本 hook の内部 ref として閉じ込める。
 *   fixedValueChange と同居させ、save 内でリセットする（本体・他 hook に出さない）。
 */
import { useCallback, useRef } from 'react'
import {
  type FixedTextMeta,
  type FixedText,
  fixedTextFieldName,
  DEFAULT_FIXEDTEXT_FONT,
  computeFixedTextFontSize,
  bboxHeightFromValue,
  bboxWidthFromValue,
  countFixedTextLines,
  clampFixedTextFontSize,
  FIXED_TEXT_FONT_SIZE_RATIO,
  fieldsToFixedTexts,
} from '@/lib/pdf-output/fixedtext-adapter'
import {
  type PageMeta,
  MIN_BBOX_PT,
  resizeBboxCentered,
} from '@/lib/pdf-output/bbox-coords'
import type { NudgeAction } from '@/app/(dashboard)/templates/[id]/nudge-controls'
import { useLayerEditor, type UseLayerEditorReturn } from './useLayerEditor'
import { updateTemplateFixedTexts } from '@/server/templates'

/** serializeFixed（bbox-editor-client.tsx のモジュール関数と同一ロジック）。 */
function serializeFixed(
  fields: import('@/app/(dashboard)/templates/[id]/bbox-pane').EditorField[],
  meta: Map<string, FixedTextMeta>,
): string {
  const metaArr = [...meta.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, m]) => ({ name, value: m.value, font: m.font }))
  return JSON.stringify({ fields, meta: metaArr })
}

/** 固定テキストの name 採番（ft_N・index ベース）。 */
function nextFixedName(used: Set<string>): string {
  for (let n = 0; ; n++) {
    const candidate = fixedTextFieldName(n)
    if (!used.has(candidate)) return candidate
  }
}

/** 追加枠の既定 meta: 空 value + 既定 font。 */
function makeDefaultFixedMeta(): FixedTextMeta {
  return { value: '', font: { ...DEFAULT_FIXEDTEXT_FONT } }
}

/** 固定テキスト value の最大文字数（サーバ FIXEDTEXT_VALUE_MAX と一致）。 */
const FIXEDTEXT_VALUE_MAX = 100

export interface UseFixedLayerParams {
  pageSizes: PageMeta[]
  templateId: string
  /** 保存成功後に背景 URL を最新 signedUrl へ更新する（キャッシュ固着対策）。 */
  refetchBackgrounds: () => Promise<void>
  /** save 失敗時のエラーコードを本体へ通知（本体の単一 errorMsg に集約）。 */
  setBodyErrorMsg: (msg: string | null) => void
}

export interface UseFixedLayerReturn extends UseLayerEditorReturn<FixedTextMeta> {
  fixedSizeStep: (delta: number) => void
  fixedValueChange: (name: string, value: string) => void
  fixedTextValueOf: (name: string) => string | undefined
  onKeyDown: (e: React.KeyboardEvent) => void
  save: () => Promise<boolean>
}

export function useFixedLayer(
  params: UseFixedLayerParams,
): UseFixedLayerReturn {
  const { pageSizes, templateId, refetchBackgrounds, setBodyErrorMsg } = params

  const base = useLayerEditor<FixedTextMeta>({
    pageSizes,
    nextName: nextFixedName,
    makeDefaultMeta: makeDefaultFixedMeta,
    serialize: serializeFixed,
  })

  const {
    fields,
    meta,
    selectedName,
    undo,
    redo,
    applyNudge,
    commitSaved,
    setSaving,
    setFields,
    setMeta,
  } = base

  // value 入力 coalesce 用（§3-3）: 同一 name・1 秒以内の連続入力は最初の 1 打前 snapshot のみ残す。
  // 本 hook 内部に閉じ込め、本体・他 hook に出さない。fixedValueChange・save と同居。
  const lastFixedValueEditRef = useRef<{ name: string | null; at: number }>({
    name: null,
    at: 0,
  })

  /**
   * 大きさボタン: font.size を delta(pt) 分増減 → bbox.h/w を再算出（中心保持リサイズ）。
   * v1.7 改行対応: N 行ぶんで bbox.h を維持しつつ font.size を変更する。undo を積む。
   * pushUndo は useLayerEditor が expose する（§2-1-b の固有ロジック向け）。
   */
  const fixedSizeStep = useCallback(
    (delta: number) => {
      if (!selectedName) return
      const f = fields.find((ff) => ff.name === selectedName)
      if (!f) return
      const pageMeta = pageSizes.find((p) => p.page === f.bbox.page)
      if (!pageMeta) return
      base.pushUndo()
      const value = meta.get(selectedName)?.value ?? ''
      const n = countFixedTextLines(value)
      const curSize = (f.bbox.h / n) * FIXED_TEXT_FONT_SIZE_RATIO
      const maxSize = (pageMeta.heightPt / n) * FIXED_TEXT_FONT_SIZE_RATIO
      const nextSize = clampFixedTextFontSize(curSize + delta, maxSize)
      const newH = bboxHeightFromValue(value, nextSize)
      const newW = bboxWidthFromValue(value, nextSize)
      const resized = resizeBboxCentered(f.bbox, newW, newH, pageMeta)
      setFields((prev) =>
        prev.map((ff) =>
          ff.name === selectedName
            ? { ...ff, bbox: { ...resized, page: ff.bbox.page } }
            : ff,
        ),
      )
    },
    [selectedName, fields, meta, pageSizes, setFields, base],
  )

  /**
   * value 入力ハンドラ（§3-2 / §3-3）。meta.value を更新し EditorField.label にも反映。
   * 同一 name・1 秒以内の連続入力は coalesce（最初の 1 打前 snapshot だけ残す）。
   */
  const fixedValueChange = useCallback(
    (name: string, value: string) => {
      const now = Date.now()
      const last = lastFixedValueEditRef.current
      if (last.name !== name || now - last.at >= 1000) {
        base.pushUndo()
      }
      lastFixedValueEditRef.current = { name, at: now }
      const clipped = value.slice(0, FIXEDTEXT_VALUE_MAX)
      setMeta((prev) => {
        const next = new Map(prev)
        const cur = next.get(name)
        next.set(name, {
          value: clipped,
          font: cur?.font ?? { ...DEFAULT_FIXEDTEXT_FONT },
        })
        return next
      })
      // v1.6: bbox.w を文字数追従で再算出。v1.7: 改行対応で bbox.h も再算出。
      setFields((prev) =>
        prev.map((f) => {
          if (f.name !== name) return f
          const prevN = countFixedTextLines(f.label ?? '')
          const fontSize = (f.bbox.h / Math.max(1, prevN)) * FIXED_TEXT_FONT_SIZE_RATIO
          const nextN = countFixedTextLines(clipped)
          let h = bboxHeightFromValue(clipped, fontSize)
          // ページ下端クランプ（v1.7）: bbox.y + bbox.h が pageHeight を超えたら頭打ち。
          const pageMeta = pageSizes.find((p) => p.page === f.bbox.page)
          if (pageMeta) {
            const maxH = Math.max(MIN_BBOX_PT, pageMeta.heightPt - f.bbox.y)
            if (h > maxH) h = maxH
          }
          let w = bboxWidthFromValue(clipped, fontSize)
          w = Math.max(MIN_BBOX_PT, w)
          void nextN
          return { ...f, label: clipped, bbox: { ...f.bbox, w, h } }
        }),
      )
    },
    [base, setMeta, setFields, pageSizes],
  )

  /** bbox-pane の fit-to-box プレビューに渡す value 解決関数。meta.value を返す。 */
  const fixedTextValueOf = useCallback(
    (name: string): string | undefined => meta.get(name)?.value,
    [meta],
  )

  /**
   * キーボード操作（矢印=移動のみ）。
   * Shift+矢印リサイズは設けない（大きさは 4 隅ドラッグに一本化・固定テキスト固有）。
   * Ctrl/⌘+Z=戻る / Ctrl/⌘+Shift+Z=進む。
   */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      const inEditable =
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        (e.target as HTMLElement)?.isContentEditable === true
      if (!inEditable && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if (inEditable) return
      if (!selectedName) return
      const moveMap: Record<string, NudgeAction> = {
        ArrowUp: 'move-up',
        ArrowDown: 'move-down',
        ArrowLeft: 'move-left',
        ArrowRight: 'move-right',
      }
      const action = moveMap[e.key]
      if (!action) return
      e.preventDefault()
      applyNudge(action) // Shift 有無に関わらず移動のみ（リサイズしない）。
    },
    [selectedName, applyNudge, undo, redo],
  )

  /**
   * 固定テキストの保存（C-2 §3-6）。専用 Server Action で fixed_texts カラムのみ更新。
   * fields/whiteout_boxes に触れず fieldsVersion も発火しない（カラム独立保存・§3-1）。
   * 保存成功後: commitSaved + lastFixedValueEditRef リセット（§3-3）+ refetchBackgrounds。
   */
  const save = useCallback(async (): Promise<boolean> => {
    setSaving(true)
    setBodyErrorMsg(null)
    const currentFields = base.fields
    const currentMeta = base.meta
    try {
      const texts: FixedText[] = fieldsToFixedTexts(currentFields, currentMeta)
      const items = texts.map((t) => ({
        name: t.name,
        value: t.value,
        bbox: t.bbox,
        font: t.font,
      }))
      await updateTemplateFixedTexts(templateId, items)
      // 保存成功: 空 value 行を除去し、meta.font.size を bbox 算出値に同期。
      const kept = currentFields.filter(
        (f) => (currentMeta.get(f.name)?.value ?? '').trim() !== '',
      )
      const keptMeta = new Map<string, FixedTextMeta>()
      for (const f of kept) {
        const m = currentMeta.get(f.name)
        if (!m || m.value.trim() === '') continue
        keptMeta.set(f.name, {
          value: m.value,
          font: {
            family: m.font.family,
            size: computeFixedTextFontSize(f.bbox, m.value),
          },
        })
      }
      // snapshot 更新 + 履歴クリア + selectedName 解除。
      commitSaved(kept, keptMeta)
      // §3-3: save で lastFixedValueEditRef をリセット（次の入力を新ステップ化）。
      lastFixedValueEditRef.current = { name: null, at: 0 }
      // 固定テキスト保存後にも背景 URL を最新 signedUrl へ更新（キャッシュ固着対策）。
      await refetchBackgrounds()
      // テンプレ一覧サムネを最新化するため再生成 API をトリガー（失敗は握りつぶす）。
      try {
        await fetch(`/api/templates/${templateId}/regenerate-thumbnail`, {
          method: 'POST',
        })
      } catch {
        // サムネ再生成失敗は致命ではない（次回入場で最新になる）。
      }
      return true
    } catch (e) {
      setBodyErrorMsg(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setSaving(false)
    }
  }, [
    templateId,
    base.fields,
    base.meta,
    commitSaved,
    refetchBackgrounds,
    setBodyErrorMsg,
    setSaving,
  ])

  return {
    ...base,
    fixedSizeStep,
    fixedValueChange,
    fixedTextValueOf,
    onKeyDown,
    save,
  }
}
