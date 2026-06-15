/**
 * bbox 操作の共通ロジック（field/whiteout/fixed の nudge/center を集約・振る舞い不変）。
 *
 * 3 系統で完全一致だった処理（対象 selectedName と setter のみ差・field 版のみ undo）を関数化。
 * React 非依存（setter と純関数 nudgeBboxByAction / centerHorizontally のみに依存）。
 *
 * undo は「先に積む」副作用なので setter 呼び出しの前に onBeforeApply?.() で注入する
 * （field 版のみ渡す）。
 */
import {
  type PageMeta,
  centerHorizontally,
  nudgeBboxByAction,
} from '@/lib/pdf-output/bbox-coords'
import type { EditorField } from '@/app/(dashboard)/templates/[id]/bbox-pane'
import type { NudgeAction } from '@/app/(dashboard)/templates/[id]/nudge-controls'

/** selectedName の field に action を適用しページ内クランプ（applyNudge 本体・3系統共通）。 */
export function nudgeSelected(
  setFields: React.Dispatch<React.SetStateAction<EditorField[]>>,
  selectedName: string | null,
  pageSizes: PageMeta[],
  action: NudgeAction,
  onBeforeApply?: () => void,
): void {
  if (!selectedName) return
  // undo: 適用前 snapshot を push（field 版のみ。push は setter 前＝従来と同タイミング）。
  onBeforeApply?.()
  setFields((prev) =>
    prev.map((f) => {
      if (f.name !== selectedName) return f
      const meta = pageSizes.find((p) => p.page === f.bbox.page)
      if (!meta) return f
      const clamped = nudgeBboxByAction(f.bbox, action, meta)
      return { ...f, bbox: { ...clamped, page: f.bbox.page } }
    }),
  )
}

/** selectedName の field を水平センタリング（applyCenter 本体・3系統共通）。 */
export function centerSelected(
  setFields: React.Dispatch<React.SetStateAction<EditorField[]>>,
  selectedName: string | null,
  pageSizes: PageMeta[],
  onBeforeApply?: () => void,
): void {
  if (!selectedName) return
  onBeforeApply?.()
  setFields((prev) =>
    prev.map((f) => {
      if (f.name !== selectedName) return f
      const meta = pageSizes.find((p) => p.page === f.bbox.page)
      if (!meta) return f
      const centered = centerHorizontally(f.bbox, meta.widthPt)
      return { ...f, bbox: { ...centered, page: f.bbox.page } }
    }),
  )
}
