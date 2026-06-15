'use client'

/**
 * 白塗りレイヤの編集ロジック。useLayerEditor<WhiteoutMeta> を包む薄いラッパ。
 *
 * 総称 hook（useLayerEditor）が持たない白塗り固有のみ追加する:
 *   - kindOf  : meta.source を解決（bbox-pane へ渡す破線/実線区別）
 *   - bgColorOf: meta.estimatedBgColor を解決（canvas 合成の塗り色）
 *   - onKeyDown: 矢印=移動 / Shift+矢印=リサイズ ＋ Ctrl/⌘+Z / Ctrl/⌘+Shift+Z
 *   - save    : whiteout-apply 再利用で再焼き込み → commitSaved → refetchBackgrounds
 *
 * 🚨 個人情報死守: save は dismissed 分を fieldsToWhiteoutBoxes が除外してから送信する。
 *    却下分が DL PDF に残らないよう、採用分のみ whiteout-apply へ渡す。
 */
import { useCallback } from 'react'
import {
  type WhiteoutMeta,
  type WhiteoutBoxInput,
  whiteoutFieldName,
  fieldsToWhiteoutBoxes,
} from '@/lib/pdf-output/whiteout-adapter'
import type { PageMeta } from '@/lib/pdf-output/bbox-coords'
import type { NudgeAction } from '@/app/(dashboard)/templates/[id]/nudge-controls'
import type { WhiteoutKind } from '@/app/(dashboard)/templates/[id]/bbox-variant'
import { useLayerEditor, type UseLayerEditorReturn } from './useLayerEditor'

/** serializeWhiteout（bbox-editor-client.tsx のモジュール関数と同一ロジック）。 */
function serializeWhiteout(
  fields: import('@/app/(dashboard)/templates/[id]/bbox-pane').EditorField[],
  meta: Map<string, WhiteoutMeta>,
): string {
  const metaArr = [...meta.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, m]) => ({
      name,
      source: m.source,
      bg: m.estimatedBgColor,
      dismissed: !!m.dismissed,
    }))
  return JSON.stringify({ fields, meta: metaArr })
}

/** 白塗りの name 採番（wo_N・index ベース）。 */
function nextWhiteoutName(used: Set<string>): string {
  for (let n = 0; ; n++) {
    const candidate = whiteoutFieldName(n)
    if (!used.has(candidate)) return candidate
  }
}

/** 追加枠の既定 meta: manual / 不透明白（焼き込みで個人情報を完全被覆）。 */
function makeDefaultWhiteoutMeta(): WhiteoutMeta {
  return { source: 'manual', estimatedBgColor: { r: 255, g: 255, b: 255 } }
}

export interface UseWhiteoutLayerParams {
  pageSizes: PageMeta[]
  templateId: string
  /** 保存成功後に背景 URL を最新 signedUrl へ更新する（キャッシュ固着対策）。 */
  refetchBackgrounds: () => Promise<void>
  /** save 失敗時のエラーコードを本体へ通知（本体の単一 errorMsg に集約）。 */
  setBodyErrorMsg: (msg: string | null) => void
}

export interface UseWhiteoutLayerReturn extends UseLayerEditorReturn<WhiteoutMeta> {
  kindOf: (name: string) => WhiteoutKind | undefined
  bgColorOf: (name: string) => { r: number; g: number; b: number }
  onKeyDown: (e: React.KeyboardEvent) => void
  save: () => Promise<boolean>
}

export function useWhiteoutLayer(
  params: UseWhiteoutLayerParams,
): UseWhiteoutLayerReturn {
  const { pageSizes, templateId, refetchBackgrounds, setBodyErrorMsg } = params

  const base = useLayerEditor<WhiteoutMeta>({
    pageSizes,
    nextName: nextWhiteoutName,
    makeDefaultMeta: makeDefaultWhiteoutMeta,
    serialize: serializeWhiteout,
  })

  const { meta, undo, redo, selectedName, applyNudge, commitSaved, setSaving, setFields, setMeta } = base

  /** 白塗り種別の解決（破線/実線・bbox-pane へ渡す）。 */
  const kindOf = useCallback(
    (name: string): WhiteoutKind | undefined => meta.get(name)?.source,
    [meta],
  )

  /** 塗り色の解決（canvas 合成で raw 上に塗る矩形の色）。meta 欠落時は不透明白で安全側。 */
  const bgColorOf = useCallback(
    (name: string) =>
      meta.get(name)?.estimatedBgColor ?? { r: 255, g: 255, b: 255 },
    [meta],
  )

  /** キーボード操作（矢印=移動 / Shift+矢印=リサイズ ＋ Ctrl/⌘+Z / Ctrl/⌘+Shift+Z）。 */
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
      if (!selectedName) return
      const map: Record<string, { move: NudgeAction; resize: NudgeAction }> = {
        ArrowUp: { move: 'move-up', resize: 'h-minus' },
        ArrowDown: { move: 'move-down', resize: 'h-plus' },
        ArrowLeft: { move: 'move-left', resize: 'w-minus' },
        ArrowRight: { move: 'move-right', resize: 'w-plus' },
      }
      const entry = map[e.key]
      if (!entry) return
      e.preventDefault()
      applyNudge(e.shiftKey ? entry.resize : entry.move)
    },
    [selectedName, applyNudge, undo, redo],
  )

  /**
   * 白塗りの保存（whiteout-apply 再利用で再焼き込み + whiteout_boxes 更新 + サムネ再生成）。
   *
   * 🚨 個人情報死守: 却下(dismissed)分は fieldsToWhiteoutBoxes が除外し、採用分のみを渡す。
   *    これにより DL PDF に却下/旧位置の白塗りが残らない（新位置の不透明白で完全被覆）。
   */
  const save = useCallback(async (): Promise<boolean> => {
    setSaving(true)
    setBodyErrorMsg(null)
    // 保存時点の最新値を ref 経由でなく base の state から読む（save は最新レンダーを保証）。
    const currentFields = base.fields
    const currentMeta = base.meta
    try {
      // 編集結果（採用分のみ・却下除外）を WhiteoutBox[] 全量へ詰め替え。
      const boxes: WhiteoutBoxInput[] = fieldsToWhiteoutBoxes(currentFields, currentMeta)
      const res = await fetch('/api/templates/pdf/whiteout-apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId, boxes }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `whiteout save failed: ${res.status}`)
      }
      // 保存成功: dismissed 分を state からも除去（再保存で食い違わない）。
      const keptFields = currentFields.filter(
        (f) => !currentMeta.get(f.name)?.dismissed,
      )
      const keptMeta = new Map<string, WhiteoutMeta>()
      for (const [name, m] of currentMeta) {
        if (!m.dismissed) keptMeta.set(name, m)
      }
      // snapshot 更新 + 履歴クリア + selectedName 解除。
      commitSaved(keptFields, keptMeta)
      // 白塗り保存で焼込済 PNG が再生成されたので背景 URL を最新 signedUrl に更新。
      await refetchBackgrounds()
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
    kindOf,
    bgColorOf,
    onKeyDown,
    save,
  }
}
