/**
 * bbox エディタ座標変換 純関数（G2-1 設計書 v0.2 §3 / §5）。
 *
 * whiteout-modal の PagePane（new/whiteout-modal.tsx L255-275, L324-333）が持つ
 * px↔pt↔表示px の座標ロジックを、UI から切り離した純関数として抽出したもの。
 * whiteout 側は今回無改変（将来ここを参照可能）。
 *
 * 座標の三層:
 *   1. pt（保存）   : PdfField.bbox の単位。左上原点 {x,y,w,h}。
 *   2. 元画像 px    : ラスタ PNG 解像度（pixelWidth/pixelHeight）。
 *   3. 表示 px      : 画面表示。displayWidth = min(pixelWidth, MAX_DISPLAY_WIDTH)。
 *
 * 設計方針（±4px 担保の核）:
 *   - 1px ステップ = 表示 px ではなく「元画像 1px 分の pt」。displayScale で表示が
 *     縮小されても pt 換算は元画像 px 基準で一定。
 *   - 編集中は丸めず float の pt を保持。保存時のみ pt を小数 2 桁へ丸める。
 *   - 途中で px↔pt を往復させない（往復のたびの丸め誤差蓄積を避ける）。
 */

/** 表示幅の上限（whiteout PagePane と同一: min(pixelWidth, 800)）。 */
export const MAX_DISPLAY_WIDTH = 800

/** リサイズ時の最小幅・高さ（pt）。これ未満には潰さない（§2-2 / S2）。 */
export const MIN_BBOX_PT = 4

/**
 * 「枠を追加」で生成する定型枠の初期サイズ（pt・グループB §2-2）。
 * 1 行テキスト相当の目安。実機チューニング前提で定数化（位置はページ中央クランプ）。
 */
export const NEW_FIELD_W_PT = 200
export const NEW_FIELD_H_PT = 24

/**
 * 重なり軽減（shrinkOverlaps・§A2-1）で隣接 bbox 間に最低限あけるすき間（pt）。
 * 上側 bbox の下端を「次の bbox の上端 - この値」までに縮める。実機チューニング前提。
 */
export const OVERLAP_GAP_PT = 1

/** フローティング nudge ウィジェットと枠／画面端のすき間（px・§A3改訂-⑦）。 */
export const WIDGET_MARGIN_PX = 8

/**
 * 上フリップ時（選択枠の上にウィジェットが来るとき）専用の間隔（px・PY2-3）。
 * 通常の下配置・左右クランプは WIDGET_MARGIN_PX 据置。上フリップのみここを使い
 * 青枠との間隔を広げる（実機調整前提）。
 */
export const WIDGET_FLIP_GAP_PX = 16

/** ズーム倍率の範囲・ステップ（PY1-1・③ズーム）。 */
export const ZOOM_MIN = 0.25
export const ZOOM_MAX = 4.0
export const ZOOM_STEP = 0.1

/** ズーム倍率を [ZOOM_MIN, ZOOM_MAX] にクランプ。 */
export function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))
}

/** nudge ウィジェットの推定寸法（px・nudge-controls 実測ベース見積り・§A3改訂-⑦）。 */
export const WIDGET_EST_HEIGHT = 180
export const WIDGET_EST_WIDTH = 300

/**
 * 破壊的ボタン（分割/削除）のクリックガード猶予（ms・実機FB）。
 *
 * 選択でフローティング nudge が出現/再配置されると、最下部の枠では上へフリップして
 * クリック地点の直上にボタンが来る。pointerup 直後に発火する合成 click がそのボタンを
 * 直撃すると「一回クリックしただけで分割/削除」が暴発する。出現/再配置からこの時間内の
 * click は誤爆とみなし破壊的ボタンだけ無視する。pointerdown→pointerup→click は通常
 * 200ms 未満で完結し、ユーザーが選択後に意図して押すのは 300ms 以上かかるため、
 * 300ms なら合成 click だけを弾き正当操作は阻害しない。
 */
export const CLICK_GUARD_MS = 300

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

/** 保存時 pt の丸め桁数（小数 2 桁。元画像 px 換算で 0.01pt ≪ 1px）。 */
export const SAVE_PT_DECIMALS = 2

export interface PageMeta {
  page: number
  widthPt: number
  heightPt: number
  pixelWidth: number
  pixelHeight: number
}

/**
 * builtin / 非 PDF テンプレ向けの固定 A4 ページサイズ。bbox-editor route の
 * SYNTHETIC_A4_PAGE と同値（builtin は source_format !== 'pdf' のため常にこの値に揃う）。
 * 未認証から呼べる経路（guest adjust 等）で `/api/templates/[id]/bbox-editor`
 * （認証必須）を呼ばずに同じ pageSizes を得るための共有定数。
 */
export const BUILTIN_SYNTHETIC_A4_PAGE: PageMeta = {
  page: 1,
  widthPt: 595,
  heightPt: 842,
  pixelWidth: 595,
  pixelHeight: 842,
}

export interface BboxPt {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 表示フィット/ズームのオプション（PY1-1）。
 * すべて任意。displayWidth/Scale/Height・ptToDisp*・dispToPt* に共通で渡す。
 */
export interface FitOptions {
  /** 横フィット（既存・スマホ ResizeObserver 連動）。省略時 MAX_DISPLAY_WIDTH。 */
  containerWidth?: number
  /** ②縦フィット基準高さ（エディタ確保高・px）。省略時 高さ制約なし（Infinity）。 */
  viewportHeight?: number
  /** ③ユーザーズーム倍率（既定 1.0）。clampZoom で 0.25〜4.0 にクランプ。 */
  zoom?: number
}

/** displayWidth 系の第2引数（number=従来 containerWidth / FitOptions）を正規化。 */
function normalizeFitOptions(opts?: number | FitOptions): FitOptions {
  return typeof opts === 'number' ? { containerWidth: opts } : (opts ?? {})
}

/**
 * 表示幅。第2引数省略時は従来どおり min(pixelWidth, MAX_DISPLAY_WIDTH)（後方互換）。
 * number 指定時（スマホ連動・§A1）は min(pixelWidth, containerWidth)（従来挙動を維持）。
 * FitOptions 指定時（PY1-1）は横フィット(widthCap)・縦フィット(heightCap)・ズーム(zoom)を反映:
 *   fitW = min(pixelWidth, widthCap, heightCap)、戻り値 = fitW × clampZoom(zoom)。
 *   ③確定: 拡大優先で元画像px を超えてOK（fitW×zoom に上限クランプを付けない・PY1-1）。
 */
export function displayWidth(meta: PageMeta, opts?: number | FitOptions): number {
  const o = normalizeFitOptions(opts)
  const zoom = clampZoom(o.zoom ?? 1)

  // widthCap: 横フィット（既存）。containerWidth 指定時 min(800, cw)、未指定 800。
  const widthCap =
    o.containerWidth && o.containerWidth > 0
      ? Math.min(MAX_DISPLAY_WIDTH, o.containerWidth)
      : MAX_DISPLAY_WIDTH

  // heightCap: ②縦フィット。表示高 ≤ viewportHeight となる表示幅上限
  //   = viewportHeight × (pixelWidth / pixelHeight)。未指定なら Infinity（従来）。
  const heightCap =
    o.viewportHeight && o.viewportHeight > 0
      ? o.viewportHeight * (meta.pixelWidth / meta.pixelHeight)
      : Infinity

  // 原寸 px・横・縦すべての上限の最小（＝全体が画面に収まる最大幅）。
  const fitW = Math.min(meta.pixelWidth, widthCap, heightCap)

  // ③ズーム: フィット幅に zoom を乗算（zoom=1 が全体フィット原点・上限クランプなし）。
  return fitW * zoom
}

/** 表示倍率 = displayWidth / pixelWidth。第2引数は number|FitOptions（後方互換）。 */
export function displayScale(meta: PageMeta, opts?: number | FitOptions): number {
  return displayWidth(meta, opts) / meta.pixelWidth
}

/** 表示高さ = pixelHeight × displayScale。 */
export function displayHeight(meta: PageMeta, opts?: number | FitOptions): number {
  return meta.pixelHeight * displayScale(meta, opts)
}

/** 元画像 px → pt の変換係数（横）。 */
export function pxToPtX(meta: PageMeta): number {
  return meta.widthPt / meta.pixelWidth
}

/** 元画像 px → pt の変換係数（縦）。 */
export function pxToPtY(meta: PageMeta): number {
  return meta.heightPt / meta.pixelHeight
}

/** pt → 表示 px（横）。描画用。第2引数省略時は従来挙動（後方互換）。 */
export function ptToDispX(meta: PageMeta, xPt: number, opts?: number | FitOptions): number {
  return (xPt / meta.widthPt) * displayWidth(meta, opts)
}

/** pt → 表示 px（縦）。描画用。 */
export function ptToDispY(meta: PageMeta, yPt: number, opts?: number | FitOptions): number {
  return (yPt / meta.heightPt) * displayHeight(meta, opts)
}

/** 表示 px → pt（横）。表示 px → 元画像 px（÷displayScale）→ pt（×pxToPtX）。 */
export function dispToPtX(meta: PageMeta, xDisp: number, opts?: number | FitOptions): number {
  return (xDisp / displayScale(meta, opts)) * pxToPtX(meta)
}

/** 表示 px → pt（縦）。 */
export function dispToPtY(meta: PageMeta, yDisp: number, opts?: number | FitOptions): number {
  return (yDisp / displayScale(meta, opts)) * pxToPtY(meta)
}

/**
 * 1px ステップ = 元画像 1px 分の pt（§2-3 / §3）。
 * 表示の縮小に依存せず、元画像 px 基準で一定の pt 量を返す。
 */
export function stepPtX(meta: PageMeta): number {
  return pxToPtX(meta)
}

export function stepPtY(meta: PageMeta): number {
  return pxToPtY(meta)
}

/** 保存時の pt 丸め（小数 SAVE_PT_DECIMALS 桁）。編集中は呼ばない。 */
export function roundPt(value: number): number {
  const f = 10 ** SAVE_PT_DECIMALS
  return Math.round(value * f) / f
}

/** bbox 全体を保存用に丸める。 */
export function roundBbox(b: BboxPt): BboxPt {
  return {
    x: roundPt(b.x),
    y: roundPt(b.y),
    w: roundPt(b.w),
    h: roundPt(b.h),
  }
}

/** リサイズ時に掴む隅。 */
export type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se'

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

/** nudge アクション名（nudge-controls の NudgeAction と一致・循環 import 回避のためここで定義）。 */
export type NudgeActionKind =
  | 'move-up'
  | 'move-down'
  | 'move-left'
  | 'move-right'
  | 'w-plus'
  | 'w-minus'
  | 'h-plus'
  | 'h-minus'

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

/**
 * bbox がページ範囲（0 ≤ x, 0 ≤ y, x+w ≤ widthPt, y+h ≤ heightPt）内かを判定。
 * 保存バリデーション（§4-2）と一致させるための純関数。
 */
export function isBboxWithinPage(b: BboxPt, meta: PageMeta): boolean {
  return (
    b.x >= 0 &&
    b.y >= 0 &&
    b.w > 0 &&
    b.h > 0 &&
    b.x + b.w <= meta.widthPt + EPS &&
    b.y + b.h <= meta.heightPt + EPS
  )
}

/** 浮動小数の境界比較用の微小許容（丸め由来の境界超過を吸収）。 */
const EPS = 0.01

/** page を持つ bbox（shrinkOverlaps 入出力）。x/y/w/h に加え page を持つ。 */
export interface PagedBboxField {
  bbox: BboxPt & { page: number }
  [key: string]: unknown
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

/** 選択枠の画面位置（フローティング nudge 配置の入力・§A3改訂-⑦）。 */
export interface NudgeGeom {
  viewportLeft: number
  viewportTop: number
  width: number
  height: number
}

/** ビューポート寸法（px）。 */
export interface ViewportSize {
  w: number
  h: number
}

/** ウィジェット寸法（px）。 */
export interface WidgetSize {
  w: number
  h: number
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
