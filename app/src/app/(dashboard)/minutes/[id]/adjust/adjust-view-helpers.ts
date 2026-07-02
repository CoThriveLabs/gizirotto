import {
  type FieldOverride,
  type BboxOverrides,
} from '@/lib/pdf-output/field-override'

export type TemplateFieldDef = {
  name: string
  label: string
  bbox: { x: number; y: number; w: number; h: number }
  multiline?: boolean
}

/**
 * 動的プレビュー: その field 自身の override.fontSize（自動なら fallback 12pt）と
 * bbox 高さの 70% のうち、小さい方を返す純関数（互換のため export 維持）。
 */
export function computePreviewFontSize(
  bboxH: number,
  ownFontSize: number | undefined,
): number {
  const requested = ownFontSize ?? 12
  return Math.min(bboxH * 0.7, requested)
}

/**
 * bbox 移動 RAF 間引き（案 A）: handleChangeBbox の中核 reducer 純関数。
 *
 * Map 化された pointermove 累積 updates を BboxOverrides に畳み込む。flushBboxChanges 内の
 * setOverrides ロジックと単一実装にするため export してテストから直接呼べる。
 *
 * 仕様:
 *   - 各 update について fields から tmpl を name で lookup、無ければ skip（不存在 field 防御）。
 *   - x / y は常に上書き。w / h は tmpl 素値と異なるときのみ書く。
 *   - 1 件も適用しなかった場合は prev をそのまま返す（参照同一 = 不要な再 render 抑止）。
 */
export function applyBboxFlushUpdates(
  prev: BboxOverrides,
  updates: Map<string, { x: number; y: number; w: number; h: number; page: number }>,
  fields: TemplateFieldDef[],
): BboxOverrides {
  if (updates.size === 0) return prev
  let next = prev
  let mutated = false
  updates.forEach((bbox, name) => {
    const tmpl = fields.find((f) => f.name === name)
    if (!tmpl) return
    const cur = next[name] ?? {}
    const entry: FieldOverride = { ...cur, x: bbox.x, y: bbox.y }
    if (bbox.w !== tmpl.bbox.w) entry.w = bbox.w
    if (bbox.h !== tmpl.bbox.h) entry.h = bbox.h
    if (!mutated) {
      next = { ...next }
      mutated = true
    }
    next[name] = entry
  })
  return mutated ? next : prev
}

/**
 * bbox.h を素 baseH → newH に拡張する際、bbox.y を shift して縦中央位置を維持する純関数。
 * 縮小（newH <= baseH）では y を動かさない（0 を返す）。
 *   - D8 旧式 (baseH - newH) / 2 は拡張時のみ意味がある（中央維持で y を上シフト）。
 *   - 縮小時にも適用すると「テンプレ余裕のある field を勝手に下シフト」+「手動移動位置を即上書き」+
 *     「fontSize 変更で元位置に戻る」副作用が出るため、縮小時は shiftY=0。
 * 呼び出し側で effectiveH = max(baseH, requiredH) と併用するため、newH <= baseH なら 0 を返すだけで
 * 「縮小しない」運用とセットで整合する。required-bbox-height.ts は触らない。
 */
export function computeBboxCenteredYShift(baseH: number, newH: number): number {
  if (newH <= baseH) return 0
  return (baseH - newH) / 2
}

/**
 * BboxPane に渡す whiteoutRawImageUrl を組み立てる純関数。
 *   - isDragging=true: 案 D OFF（rawBgUrl 固定）。drag 中に selected が変わっても
 *     whiteoutRawImageUrl は不変 → bbox-pane.tsx の rawImg ロード useEffect が再走しない →
 *     setRawImg(null) によるブランクアウトが構造的に起きない。
 *   - isDragging=false: 案 D 通常経路（selectedOnlyBgUrl ?? rawBgUrl）。
 * 背景未取得（rawBgUrl=null）の場合は null を返す。
 */
export function resolveWhiteoutRawImageUrl(
  isDragging: boolean,
  rawBgUrl: string | null,
  selectedOnlyBgUrl: string | null,
): string | null {
  if (isDragging) return rawBgUrl
  return selectedOnlyBgUrl ?? rawBgUrl
}

/**
 * dynamicFieldValues（client canvas 合成に乗せる記入値）に、ある field を含めるか判定する純関数。
 *
 * ── 不変条件: A∩B=∅ を構造保証する ──────────────────────────────────────
 * A = 背景PNG（selectedOnlyBgUrl=_raw_except_<selected>）に焼かれる field 集合 = 全field − {selected}
 * B = client 合成する field 集合（本関数が true を返す field 群）
 * compositeFieldValuesOnCanvas は fillText 重ね描き（背景ピクセルを消さない）ため、
 * A∩B≠∅ の field は「背景PNG(DB位置)」+「client(override位置)」で二重描画される。
 *
 * hasOverride 分岐は撤回済み（二重描画の張本人だった）。絶対に復活させない。override 残留時の
 * 二重描画は、呼出側で hasAnyOverride 時に selected を null にして selectedOnlyBgUrl を生成させない
 * ことで A∩B=∅ を構造保証する。
 *
 * 判定:
 *   - useSelectedOnly = !isDragging && selected !== null && selectedOnlyBgUrl !== null
 *       isDragging 中は必ず false → 全 field を override 付きで client 合成しスナップに焼く。
 *   - 含める条件: !useSelectedOnly || field === selected
 *       useSelectedOnly のとき B={selected}・A=全field−{selected} で A∩B=∅。
 *   selectedOnlyBgUrl が null のときは useSelectedOnly=false で全 field を client 合成
 *   （B=全field・A=rawBgUrl(空集合)で A∩B=∅）。両ケースで A∩B=∅ が成立する。
 */
export function shouldComposeFieldClientSide(args: {
  fieldName: string
  selected: string | null
  selectedOnlyBgUrl: string | null
  isDragging: boolean
}): boolean {
  const { fieldName, selected, selectedOnlyBgUrl, isDragging } = args
  const useSelectedOnly = !isDragging && selected !== null && selectedOnlyBgUrl !== null
  if (!useSelectedOnly) return true
  if (fieldName === selected) return true
  return false
}
