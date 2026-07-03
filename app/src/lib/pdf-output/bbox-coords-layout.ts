/**
 * bbox エディタ座標変換 純関数（G2-1 設計書 v0.2 §3 / §5）。重なり軽減 / nudge 配置系。
 */
import {
  MIN_BBOX_PT,
  OVERLAP_GAP_PT,
  WIDGET_MARGIN_PX,
  WIDGET_FLIP_GAP_PX,
  CLICK_GUARD_MS,
  type BboxPt,
  type PagedBboxField,
  type NudgeGeom,
  type ViewportSize,
  type WidgetSize,
} from './bbox-coords-constants'

/**
 * 当該 click が「ウィジェット出現/再配置の直後に来た誤爆 click」かを判定する純関数（実機FB）。
 * armedAt = 出現/再配置時刻（ms）、now = click 発火時刻（ms）。差が CLICK_GUARD_MS 未満なら
 * 誤爆（破壊的ボタンを無視すべき）。armedAt=0（未武装）は誤爆扱いにしない。
 *
 * 純関数（DOM/時刻ソース非依存・unit テスト対象）。
 */
export function isWidgetEmergenceClick(
  now: number,
  armedAt: number,
  guardMs: number = CLICK_GUARD_MS,
): boolean {
  if (armedAt <= 0) return false
  return now - armedAt < guardMs
}

/** 2 つの bbox が x 方向で重なるか（同一カラム＝縦に積まれた関係か）の判定。 */
function overlapsX(a: BboxPt, b: BboxPt): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w
}

/**
 * 重なり軽減（§A2-1）。検出器（field-bbox-detector）は無改変のまま、取得時に
 * 過大 bbox（area B 大枠の h 過大で縦に重なる）を縮めて初期表示の正にする。
 *
 * アルゴリズム（差し戻し-A1 対応・同カラム縦隣接ペアリング）:
 *   - 同一ページごとに y(上端) 昇順で並べる。
 *   - 各 field について「**x 方向で重なり（同カラム）かつ y がそれ以降にある最も近い項目**」を
 *     縦の隣接相手とする（別カラムの横並び項目は x 非重なりで対象外＝誤縮小しない）。
 *   - 隣接相手と縦に重なる（自分の下端 y+h > 相手の上端 y）なら、上側 h を
 *     「相手の y - 自分の y - OVERLAP_GAP_PT」に縮める（相手は動かさない）。
 *   - 縮めた結果 h が MIN_BBOX_PT 未満なら MIN_BBOX_PT でクランプ（潰さない）。
 *   - x 方向の重なりが無い横並び（部署｜氏名 等）は h 不変（設計§A2-1 明文）。
 *   - 連鎖する重なりも、縮小後の下端を基準に y 昇順で順に処理する。
 *
 * 純関数（入力を破壊せず新配列を返す）。入力の並び順は保持して返す。
 *
 * @param fields    page 付き bbox を持つ field 配列
 * @returns 重なりを縮めた新 field 配列（並び順は入力どおり）
 */
export function shrinkOverlaps<T extends PagedBboxField>(fields: T[]): T[] {
  // 元の位置を保ったまま結果を返すため、index を保持して並べ替え→上書きする。
  const result = fields.map((f) => ({ ...f, bbox: { ...f.bbox } })) as T[]

  // ページごとに該当 result の index を集める。
  const byPage = new Map<number, number[]>()
  result.forEach((f, i) => {
    const arr = byPage.get(f.bbox.page) ?? []
    arr.push(i)
    byPage.set(f.bbox.page, arr)
  })

  for (const indices of byPage.values()) {
    // y(上端) 昇順。同 y は元の順序を保つ安定ソート。
    indices.sort((a, b) => result[a].bbox.y - result[b].bbox.y)
    for (let k = 0; k < indices.length; k++) {
      const cur = result[indices[k]].bbox
      // 自分と x 方向で重なる（同カラム）後続のうち、最も上端 y が近いものを縦の隣接相手にする。
      // 別カラムを挟んでも、x ガードで横並びを除外しつつ同カラムの真の隣接を拾える（堅実版）。
      let neighbor: BboxPt | null = null
      for (let j = k + 1; j < indices.length; j++) {
        const cand = result[indices[j]].bbox
        if (!overlapsX(cur, cand)) continue // 横並び（別カラム）は対象外
        neighbor = cand // y 昇順なので最初に見つかった同カラム後続が最近接
        break
      }
      if (!neighbor) continue
      const curBottom = cur.y + cur.h
      if (curBottom > neighbor.y) {
        // 縦に重なっている → 上側 h を「相手の上端 - 自分の上端 - GAP」に縮める。
        const shrunkH = neighbor.y - cur.y - OVERLAP_GAP_PT
        cur.h = Math.max(MIN_BBOX_PT, shrunkH)
      }
    }
  }

  return result
}

/** 値を [lo, hi] にクランプ（hi < lo のときは lo を優先）。 */
function clamp(lo: number, value: number, hi: number): number {
  return Math.max(lo, Math.min(value, hi))
}

/**
 * フローティング nudge ウィジェットの画面内配置を計算する（§A3改訂-⑦）。
 *
 * - 第一候補は選択枠の「下」（枠下端 + MARGIN）。
 * - 下に置くとビューポート下端を超えるなら「上」へフリップ（枠上端 - widget高 - flipGap）。
 *   上フリップ時のみ間隔を flipGap（既定 WIDGET_FLIP_GAP_PX）に広げ青枠との被りを軽減（PY2-3）。
 *   上も画面上端より上（< margin）になるなら、画面内に収まる位置へクランプ。
 * - 横位置は枠左端を基準に、画面左右端からあふれないようクランプ（margin 据置）。
 *
 * 純関数（DOM 非依存・unit テスト対象）。後方互換: 既存呼び出しは margin のみ指定で従来動作、
 * flipGap 省略時は WIDGET_FLIP_GAP_PX が上フリップ間隔に適用される。
 */
export function computeNudgePosition(
  geom: NudgeGeom,
  viewport: ViewportSize,
  widget: WidgetSize,
  margin: number = WIDGET_MARGIN_PX,
  flipGap: number = WIDGET_FLIP_GAP_PX,
): { left: number; top: number } {
  const down = geom.viewportTop + geom.height + margin
  let top: number
  if (down + widget.h > viewport.h) {
    // 下に入らない → 上へフリップ（上方向のみ flipGap で間隔を広げる）。
    const up = geom.viewportTop - widget.h - flipGap
    top = up >= margin ? up : clamp(margin, up, viewport.h - widget.h - margin)
  } else {
    top = down
  }
  const left = clamp(margin, geom.viewportLeft, viewport.w - widget.w - margin)
  return { left, top }
}
