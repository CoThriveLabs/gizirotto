/**
 * bbox エディタ座標変換 純関数（G2-1 設計書 v0.2 §3 / §5）。
 *
 * whiteout-modal の PagePane（new/whiteout-modal.tsx L255-275, L324-333）が持つ
 * px↔pt↔表示px の座標ロジックを、UI から切り離した純関数として抽出したもの。
 * whiteout 側は今回無改変（将来ここを参照可能）。
 *
 * 実体は const/型（bbox-coords-constants）・座標変換（bbox-coords-transform）・
 * resize/move/nudge/split（bbox-coords-resize）・重なり軽減/nudge配置（bbox-coords-layout）
 * の 4 ファイルに分割されている。本ファイルはそれらを再エクスポートする barrel。
 */
export * from './bbox-coords-constants'
export * from './bbox-coords-transform'
export * from './bbox-coords-resize'
export * from './bbox-coords-layout'
