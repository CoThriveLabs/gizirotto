/**
 * bbox エディタ座標変換の共有 const / 型（bbox-coords barrel の分割先）。
 * transform / resize / layout の各分割ファイルが参照する頂点ファイル（何も import しない）。
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

/** リサイズ時に掴む隅。 */
export type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se'

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

/** page を持つ bbox（shrinkOverlaps 入出力）。x/y/w/h に加え page を持つ。 */
export interface PagedBboxField {
  bbox: BboxPt & { page: number }
  [key: string]: unknown
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
