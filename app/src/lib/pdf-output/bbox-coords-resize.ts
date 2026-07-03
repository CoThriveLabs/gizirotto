/**
 * bbox エディタ座標変換 純関数（G2-1 設計書 v0.2 §3 / §5）。resize / move / nudge / split 系。
 */
import {
  MIN_BBOX_PT,
  NEW_FIELD_W_PT,
  NEW_FIELD_H_PT,
  type PageMeta,
  type BboxPt,
  type ResizeCorner,
  type NudgeActionKind,
} from './bbox-coords-constants'
import { stepPtX, stepPtY } from './bbox-coords-transform'

/**
 * 四隅リサイズ。掴んだ隅の対角を固定点として x/y/w/h を再計算する。
 * w/h は MIN_BBOX_PT でクランプし、反転（負幅）を禁止する（§2-2 / S2）。
 *
 * @param b       現在の bbox（pt）
 * @param corner  掴んだ隅
 * @param dxPt    pointer の x 移動量（pt、右が正）
 * @param dyPt    pointer の y 移動量（pt、下が正）
 */
export function resizeBbox(
  b: BboxPt,
  corner: ResizeCorner,
  dxPt: number,
  dyPt: number,
): BboxPt {
  // 対角の固定点（動かさない角）。
  const left = b.x
  const right = b.x + b.w
  const top = b.y
  const bottom = b.y + b.h

  // 掴んだ隅を移動させた後の左右・上下端。
  let newLeft = left
  let newRight = right
  let newTop = top
  let newBottom = bottom

  if (corner === 'nw') {
    newLeft = left + dxPt
    newTop = top + dyPt
  } else if (corner === 'ne') {
    newRight = right + dxPt
    newTop = top + dyPt
  } else if (corner === 'sw') {
    newLeft = left + dxPt
    newBottom = bottom + dyPt
  } else {
    newRight = right + dxPt
    newBottom = bottom + dyPt
  }

  // 反転禁止 + 最小クランプ: 固定辺を基準に最小サイズを保証する。
  // 左を動かす隅（nw/sw）は左端が固定右端を超えない位置にクランプ。
  if (corner === 'nw' || corner === 'sw') {
    newLeft = Math.min(newLeft, newRight - MIN_BBOX_PT)
  } else {
    newRight = Math.max(newRight, newLeft + MIN_BBOX_PT)
  }
  if (corner === 'nw' || corner === 'ne') {
    newTop = Math.min(newTop, newBottom - MIN_BBOX_PT)
  } else {
    newBottom = Math.max(newBottom, newTop + MIN_BBOX_PT)
  }

  return {
    x: newLeft,
    y: newTop,
    w: newRight - newLeft,
    h: newBottom - newTop,
  }
}

/**
 * 縦横比保持リサイズ（C-2 v1.5 準備・固定テキスト用・案B 復活）。
 *
 * `resizeBbox`（自由リサイズ・対角固定・スケール係数なし）を土台に、**縦横比 `aspect = w/h` を維持**
 * したまま掴んだ隅をポインタに追従させる。anchor（掴んだ隅の対角）は不動・スケール係数を一切使わない
 * （v1.1 暴走バグの根本回避は据置）。
 *
 * アルゴリズム（長辺基準・歪みゼロ）:
 *   1. まず resizeBbox で自由リサイズの raw（w_raw, h_raw）を得る（anchor=対角は不動）。
 *   2. **長辺基準**で比率を当てる: |w_raw − w0| と |h_raw − h0|（変化量）の大きい方を主軸とし、
 *      主軸の寸法から従軸を `aspect` で導く（w 主軸なら h := w/aspect、h 主軸なら w := h*aspect）。
 *      → カーソルの主たる移動方向を尊重しつつ比率を保つ（直感的）。
 *   3. anchor（対角の角）を固定したまま w/h を更新し、掴んだ隅側の x/y を再計算する。
 *   4. 最小サイズ `MIN_BBOX_PT` は両辺で維持（比率を保ったまま下限クランプ）。
 *
 * ※ ページ端クランプは呼び出し側（clampResizeToPage 等）に委ねず、ここでは行わない設計も可能だが、
 *   比率保持と端クランプを両立させると比率が崩れるため、**端クランプも比率保持で行う**専用引数
 *   `meta` を任意で受ける（指定時のみページ内に収まる最大の同比率矩形へ収める）。
 *
 * @param b       現在の bbox（pt・リサイズ開始時の startBbox を渡す）
 * @param corner  掴んだ隅
 * @param dxPt    pointer の x 移動量（pt）
 * @param dyPt    pointer の y 移動量（pt）
 * @param aspect  維持する縦横比（w/h）。通常 startBbox の w/h を渡す。
 * @param meta    指定時はページ内クランプ（比率保持）まで行う。省略時はクランプなし。
 */
export function resizeBboxKeepAspect(
  b: BboxPt,
  corner: ResizeCorner,
  dxPt: number,
  dyPt: number,
  aspect: number,
  meta?: PageMeta,
): BboxPt {
  // 安全: aspect 不正（0/NaN/負）は自由リサイズへフォールバック（呼び出し側保険）。
  if (!(aspect > 0)) return resizeBbox(b, corner, dxPt, dyPt)

  // 1. 自由リサイズの raw（anchor=対角は不動・スケール係数なし）。
  const raw = resizeBbox(b, corner, dxPt, dyPt)

  // 2. 長辺基準: 変化量の大きい軸を主軸にして従軸を比率から導く。
  const dW = Math.abs(raw.w - b.w)
  const dH = Math.abs(raw.h - b.h)
  let w: number
  let h: number
  if (dW >= dH) {
    w = raw.w
    h = w / aspect
  } else {
    h = raw.h
    w = h * aspect
  }

  // 4. 最小サイズを比率保持で確保（どちらかが下限割れなら比率維持で押し上げ）。
  if (w < MIN_BBOX_PT) {
    w = MIN_BBOX_PT
    h = w / aspect
  }
  if (h < MIN_BBOX_PT) {
    h = MIN_BBOX_PT
    w = h * aspect
  }

  // 3. anchor（掴んだ隅の対角）を固定したまま掴んだ隅側の x/y を再構成する。
  //    anchor は resizeBbox と同じ「動かさない角」。corner ごとに対角の固定点を定める。
  const fixedRight = corner === 'nw' || corner === 'sw' // 左を掴む＝右端が anchor
  const fixedBottom = corner === 'nw' || corner === 'ne' // 上を掴む＝下端が anchor
  const anchorX = fixedRight ? b.x + b.w : b.x
  const anchorY = fixedBottom ? b.y + b.h : b.y
  let x = fixedRight ? anchorX - w : anchorX
  let y = fixedBottom ? anchorY - h : anchorY

  // ページ端クランプ（任意・比率保持）: anchor を固定したままページ内に収まる最大の同比率矩形へ。
  if (meta) {
    // anchor から各方向に取れる最大長（pt）。
    const maxW = fixedRight ? anchorX : meta.widthPt - anchorX
    const maxH = fixedBottom ? anchorY : meta.heightPt - anchorY
    // 比率を保ったまま maxW/maxH の制約に収める縮小係数。
    const scaleW = w > maxW ? maxW / w : 1
    const scaleH = h > maxH ? maxH / h : 1
    const s = Math.min(scaleW, scaleH)
    if (s < 1) {
      w = Math.max(MIN_BBOX_PT, w * s)
      h = w / aspect
      x = fixedRight ? anchorX - w : anchorX
      y = fixedBottom ? anchorY - h : anchorY
    }
  }

  return { x, y, w, h }
}

/**
 * 中心保持リサイズ（C-2 v1.5 §3-2-4・大きさボタン用）。
 *
 * 現 bbox の**中心を固定**したまま新しい w/h（`newW`/`newH`）へ拡縮する（四方へ均等）。
 * 大きさボタンで font.size を ± した結果の bbox.h/w（縦横比 aspect 連動）を渡す想定。
 *
 * ページ端クランプ（中心保持優先）:
 *   中心を動かさずページ内に収まる最大の同 w/h 比へ縮める。具体的には、中心から各辺まで取れる
 *   半幅・半高の上限（min(中心x, pageW−中心x) と min(中心y, pageH−中心y)）で w/h を頭打ちにし、
 *   w/h の縮小係数の小さい方を両辺へ適用（比率＝newW/newH を保ったまま中心固定で収める）。
 *   最小 MIN_BBOX_PT は維持する。
 *
 * @param b     現在の bbox（pt）。中心算出に使う。
 * @param newW  目標幅（pt）
 * @param newH  目標高さ（pt）
 * @param meta  指定時はページ内クランプ（中心保持）まで行う。省略時はクランプなし。
 */
export function resizeBboxCentered(
  b: BboxPt,
  newW: number,
  newH: number,
  meta?: PageMeta,
): BboxPt {
  const cx = b.x + b.w / 2
  const cy = b.y + b.h / 2
  let w = Math.max(MIN_BBOX_PT, newW)
  let h = Math.max(MIN_BBOX_PT, newH)

  if (meta) {
    // 中心から各方向に取れる最大半幅・半高（中心固定で収まる限界）。
    const maxHalfW = Math.min(cx, meta.widthPt - cx)
    const maxHalfH = Math.min(cy, meta.heightPt - cy)
    const maxW = Math.max(MIN_BBOX_PT, maxHalfW * 2)
    const maxH = Math.max(MIN_BBOX_PT, maxHalfH * 2)
    // 比率（w/h）を保ったまま w/h を上限に収める縮小係数（小さい方を両辺に適用）。
    const sW = w > maxW ? maxW / w : 1
    const sH = h > maxH ? maxH / h : 1
    const s = Math.min(sW, sH)
    if (s < 1) {
      w = Math.max(MIN_BBOX_PT, w * s)
      h = Math.max(MIN_BBOX_PT, h * s)
    }
  }

  return { x: cx - w / 2, y: cy - h / 2, w, h }
}

/**
 * 移動（w/h 不変で x/y に加算）。
 */
export function moveBbox(b: BboxPt, dxPt: number, dyPt: number): BboxPt {
  return { x: b.x + dxPt, y: b.y + dyPt, w: b.w, h: b.h }
}

/**
 * 移動 nudge のページ内クランプ（記入欄/白塗り/固定テキスト 3 経路で共用・リファクタ⑤）。
 *
 * w/h は不変のまま x/y だけを「枠全体がページ内に収まる」範囲へ引き戻す:
 *   x ∈ [0, widthPt − w]、y ∈ [0, heightPt − h]
 * 各 nudge ハンドラにインライン重複していた
 *   Math.max(0, Math.min(nb.x, meta.widthPt − nb.w)) 等
 * と完全に等価（page は呼び出し側で付与）。
 */
export function clampBboxToPage(b: BboxPt, meta: PageMeta): BboxPt {
  return {
    x: Math.max(0, Math.min(b.x, meta.widthPt - b.w)),
    y: Math.max(0, Math.min(b.y, meta.heightPt - b.h)),
    w: b.w,
    h: b.h,
  }
}

/**
 * リサイズ専用のページ内クランプ（移動用 clampToPage と分離・差し戻し-3）。
 *
 * 移動用 clampToPage は w/h 固定前提で x/y を引き戻すため、リサイズ経路に流すと
 * 枠がページ端に達した瞬間に x/y が引き戻され、リサイズと平行移動が綱引きして
 * 枠が縮みながら動いて見える。リサイズでは x/y を引き戻さず、はみ出した辺だけを
 * 0〜ページ寸法にクランプして w/h を縮める。最小 MIN_BBOX_PT は維持する。
 */
export function clampResizeToPage(b: BboxPt, meta: PageMeta): BboxPt {
  let { x, y, w, h } = b

  // 左/上のはみ出し: 端を 0 に寄せ、その分 w/h を縮める（右下端は動かさない）。
  if (x < 0) {
    w += x // x が負なので w は縮む
    x = 0
  }
  if (y < 0) {
    h += y
    y = 0
  }
  // 右/下のはみ出し: 右下端をページ内へ。x/y は動かさない（綱引き回避）。
  if (x + w > meta.widthPt) {
    w = meta.widthPt - x
  }
  if (y + h > meta.heightPt) {
    h = meta.heightPt - y
  }

  // クランプで潰れても最小サイズは確保。
  w = Math.max(MIN_BBOX_PT, w)
  h = Math.max(MIN_BBOX_PT, h)
  return { x, y, w, h }
}

/**
 * 幅・高さの 1 ステップ増減（最小クランプ・反転禁止）。
 * 微調整 UI のサイズパッド用。x/y は固定（左上基準で w/h のみ変化）。
 */
export function nudgeSize(
  b: BboxPt,
  dwPt: number,
  dhPt: number,
): BboxPt {
  return {
    x: b.x,
    y: b.y,
    w: Math.max(MIN_BBOX_PT, b.w + dwPt),
    h: Math.max(MIN_BBOX_PT, b.h + dhPt),
  }
}

/**
 * 選択 bbox を水平センタリング（左右余白を均等に・PY2-1 / Q-Y1 案a）。
 * x のみ変更・y/w/h 不変。x = (pageWidthPt − w) / 2。
 * w がページ幅を超える異常時は x=0 にクランプ（負 x 防止）。
 * pt 空間で直接確定（applyNudge 同様 stepPt 非依存・編集精度に無影響）。
 */
export function centerHorizontally(b: BboxPt, pageWidthPt: number): BboxPt {
  const x = Math.max(0, (pageWidthPt - b.w) / 2)
  return { x, y: b.y, w: b.w, h: b.h }
}

/**
 * nudge アクション → 操作種別と (dx,dy)/(dw,dh) 係数のテーブル。
 * move 系は (sx,sy) を移動量、size 系は (sx,sy) をサイズ増減量として符号付きで適用。
 * ※ field/whiteout/fixed の 3 系統で全く同一だった 8 case switch をこの表に集約（振る舞い不変）。
 */
const NUDGE_VECTORS: Record<
  NudgeActionKind,
  { kind: 'move' | 'size'; fx: number; fy: number }
> = {
  'move-up': { kind: 'move', fx: 0, fy: -1 },
  'move-down': { kind: 'move', fx: 0, fy: 1 },
  'move-left': { kind: 'move', fx: -1, fy: 0 },
  'move-right': { kind: 'move', fx: 1, fy: 0 },
  'w-plus': { kind: 'size', fx: 1, fy: 0 },
  'w-minus': { kind: 'size', fx: -1, fy: 0 },
  'h-plus': { kind: 'size', fx: 0, fy: 1 },
  'h-minus': { kind: 'size', fx: 0, fy: -1 },
}

/**
 * 単一 bbox に nudge を適用しページ内クランプまで行う純関数（field/whiteout/fixed 共通）。
 * 従来の 8 case switch + clampBboxToPage と完全等価:
 *   - move 系: moveBbox(b, fx*sx, fy*sy) → clampBboxToPage
 *   - size 系: nudgeSize(b, fx*sx, fy*sy) → clampBboxToPage
 * page は呼び出し側で b.page を付け直す（従来どおり meta は b.page で引く前提）。
 */
export function nudgeBboxByAction(
  b: BboxPt,
  action: NudgeActionKind,
  meta: PageMeta,
): BboxPt {
  const sx = stepPtX(meta)
  const sy = stepPtY(meta)
  const v = NUDGE_VECTORS[action]
  const nb =
    v.kind === 'move'
      ? moveBbox(b, v.fx * sx, v.fy * sy)
      : nudgeSize(b, v.fx * sx, v.fy * sy)
  return clampBboxToPage(nb, meta)
}

/**
 * 縦割り 2 分割（グループB §3-2・「部署＋氏名」を左右 2 枠に割る本命）。
 *
 * 元 bbox を中央で左右に分割する純関数（pt 直接演算・往復なし＝±4px 自動担保）:
 *   - 左枠（元 field 側）: { x, y, w: w/2, h }
 *   - 右枠（新 field 側）: { x: x + w/2, y, w: w/2, h }
 * page は両枠とも元 bbox を継承。gap は設けず隣接（必要なら将来 OVERLAP_GAP_PT 相当を検討）。
 *
 * 注: 分割可否（w/2 < MIN_BBOX_PT なら不可）の判定は呼び出し側（UI のボタン disabled）で行う。
 * 本関数は中央 2 分割の座標振り分けのみを担う（page を持つ bbox にも対応するため page を引き継ぐ）。
 */
export function splitVertical<B extends BboxPt>(bbox: B): [B, B] {
  const halfW = bbox.w / 2
  const left = { ...bbox, x: bbox.x, w: halfW }
  const right = { ...bbox, x: bbox.x + halfW, w: halfW }
  return [left, right]
}

/**
 * 「枠を追加」で生成する中央定型枠の bbox を作る（グループB §2-2）。
 *
 * サイズは NEW_FIELD_W_PT / NEW_FIELD_H_PT。位置はページ中央
 *   x = (widthPt - w) / 2, y = (heightPt - h) / 2
 * とし、ページより枠が大きい異常時でも 0 を下回らないようクランプする
 * （結果が isBboxWithinPage を満たすことを呼び出し側で前提にできる）。
 *
 * pt 直接演算（往復なし＝±4px 自動担保）。page は引数のメタから引き継ぐ。
 */
export function centeredNewBbox(meta: PageMeta): BboxPt & { page: number } {
  const w = Math.min(NEW_FIELD_W_PT, meta.widthPt)
  const h = Math.min(NEW_FIELD_H_PT, meta.heightPt)
  const x = Math.max(0, (meta.widthPt - w) / 2)
  const y = Math.max(0, (meta.heightPt - h) / 2)
  return { x, y, w, h, page: meta.page }
}
