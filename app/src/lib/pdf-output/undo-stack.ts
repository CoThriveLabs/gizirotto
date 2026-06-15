/**
 * bbox-editor（記入欄編集）の undo/redo 純ロジック。
 *
 * 設計書: docs/designs/bbox_editor_undo_design_2026-06-05.md
 *   - §0-1 スナップショット・スタック方式（fields 全量履歴）
 *   - §0-2 巻き戻す state 一式（fields ＋ newFieldNames / labelDirtyNames を1組）
 *   - §1-2 nudge の coalesce（同一 selectedName × 短時間の連続を1ステップにまとめる）
 *   - §2-4 スタック上限（FIFO）
 *   - §5-2 redo（U-2）
 *
 * ここは DOM/React 非依存の純関数のみ（ユニットテスト対象・§9-1）。React 側は本関数を呼ぶだけ。
 */

import type { EditorField } from '@/app/(dashboard)/templates/[id]/bbox-pane'

/**
 * 1ステップのスナップショット（§2-1）。
 * Set はスナップショットでは**配列化**して持つ（不変・複製安全＝参照共有による巻き戻し汚染を防ぐ）。
 */
export interface EditSnapshot {
  fields: EditorField[]
  newFieldNames: string[]
  labelDirtyNames: string[]
}

/** スタック上限（§2-4）。超過は古いものから捨てる（FIFO）。 */
export const UNDO_STACK_LIMIT = 50

/** nudge coalesce の時間窓（ms・§1-2）。同一 selectedName でこの間隔内の連続 nudge を1ステップに。 */
export const NUDGE_COALESCE_MS = 600

/**
 * スナップショットを安全に複製する（fields は浅いコピーで十分＝bbox は操作のたびに新オブジェクト生成、
 * 付随集合は配列を新規化）。React state へ流し込む前後で参照共有を断ち、巻き戻しの相互汚染を防ぐ。
 */
export function cloneSnapshot(snap: EditSnapshot): EditSnapshot {
  return {
    fields: snap.fields.map((f) => ({ ...f, bbox: { ...f.bbox } })),
    newFieldNames: [...snap.newFieldNames],
    labelDirtyNames: [...snap.labelDirtyNames],
  }
}

/**
 * スタックへ push（§2-2 / §2-4）。
 *
 * - `coalesce=true`: スタックが空でなければ**トップを差し替えず**現状を保持する
 *   （＝最初の押下前 snapshot を温存）。具体的には「新しい snap を積まない」。
 *   coalesce の意図は「連続 nudge の最初の1つ前状態だけ残す」なので、2回目以降の nudge では
 *   何も積まない＝トップ（最初の押下前）がそのまま undo 先になる。
 *   スタックが空（最初の nudge）の場合は coalesce でも通常 push する。
 * - `coalesce=false`: 末尾へ append。上限超過分は先頭（最古）から落とす（FIFO）。
 *
 * 返り値は**新しい配列**（元配列は不変・React setState 安全）。
 */
export function pushSnapshot(
  stack: EditSnapshot[],
  snap: EditSnapshot,
  opts?: { coalesce?: boolean; limit?: number },
): EditSnapshot[] {
  const coalesce = opts?.coalesce ?? false
  const limit = opts?.limit ?? UNDO_STACK_LIMIT

  // coalesce かつスタックに既存トップがある＝連続 nudge の2回目以降。何も積まない（トップ温存）。
  if (coalesce && stack.length > 0) {
    return stack
  }

  const next = [...stack, cloneSnapshot(snap)]
  // 上限 FIFO（最古を捨てる）。
  if (next.length > limit) {
    return next.slice(next.length - limit)
  }
  return next
}

/** スタックのトップを取り出す（pop）。返り値: { snap, rest }。空なら snap=null。 */
export function popSnapshot(stack: EditSnapshot[]): {
  snap: EditSnapshot | null
  rest: EditSnapshot[]
} {
  if (stack.length === 0) return { snap: null, rest: stack }
  return { snap: stack[stack.length - 1], rest: stack.slice(0, -1) }
}

// ── #20 全モードUI統一: 白塗り/固定テキスト用の汎用 undo スタック ───────────────────
//
// 白塗り・固定テキストモードは記入欄ほど複雑な付随集合（newFieldNames/labelDirtyNames）を
// 持たず、「fields（EditorField[]）＋ side table meta（Map<string, M>）」の2点1組で状態が決まる。
// モードごとに独立スタックを持つ（モード切替で他モードの履歴を辿らない）。
// meta は Map をそのまま履歴に持つと参照共有で巻き戻しが汚染されるため**配列化**して保持する。

/** 1ステップのレイヤ・スナップショット（白塗り/固定共通・M は WhiteoutMeta | FixedTextMeta）。 */
export interface LayerSnapshot<M> {
  fields: EditorField[]
  /** side table を [name, meta] のタプル配列で保持（Map は復元時に new Map(...) で組む）。 */
  meta: Array<[string, M]>
}

/**
 * レイヤ・スナップショットを安全に複製する（fields は bbox まで深掘りコピー、
 * meta はタプル配列を新規化＋各 meta を浅いコピー）。参照共有を断ち巻き戻しの相互汚染を防ぐ。
 */
export function cloneLayerSnapshot<M>(snap: LayerSnapshot<M>): LayerSnapshot<M> {
  return {
    fields: snap.fields.map((f) => ({ ...f, bbox: { ...f.bbox } })),
    meta: snap.meta.map(([name, m]) => [name, { ...m }] as [string, M]),
  }
}

/**
 * レイヤ・スタックへ push（FIFO 上限つき）。返り値は新配列（元配列は不変・setState 安全）。
 * 白塗り/固定は nudge coalesce を行わない（1操作=1ステップで十分・記入欄ほど連打しない）。
 */
export function pushLayerSnapshot<M>(
  stack: LayerSnapshot<M>[],
  snap: LayerSnapshot<M>,
  opts?: { limit?: number },
): LayerSnapshot<M>[] {
  const limit = opts?.limit ?? UNDO_STACK_LIMIT
  const next = [...stack, cloneLayerSnapshot(snap)]
  if (next.length > limit) return next.slice(next.length - limit)
  return next
}

/** レイヤ・スタックのトップを取り出す（pop）。空なら snap=null。 */
export function popLayerSnapshot<M>(stack: LayerSnapshot<M>[]): {
  snap: LayerSnapshot<M> | null
  rest: LayerSnapshot<M>[]
} {
  if (stack.length === 0) return { snap: null, rest: stack }
  return { snap: stack[stack.length - 1], rest: stack.slice(0, -1) }
}

/**
 * nudge の coalesce 判定（§1-2）。
 * 「直前 push が nudge 由来」かつ「同一 selectedName」かつ「now - lastAt < windowMs」なら true
 * ＝今回の nudge は新ステップを積まずトップ（最初の押下前）に集約する。
 */
export function shouldCoalesceNudge(
  last: { kind: 'nudge' | 'other' | null; name: string | null; at: number } | null,
  current: { name: string; now: number },
  windowMs: number = NUDGE_COALESCE_MS,
): boolean {
  if (!last) return false
  if (last.kind !== 'nudge') return false
  if (last.name !== current.name) return false
  return current.now - last.at < windowMs
}
