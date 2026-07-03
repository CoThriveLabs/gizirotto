/** 編集モード（設計書 §4-1 / C-2 §3-2）: 記入欄 / 白塗り / 固定テキストのレイヤ切替。 */
export type EditMode = 'field' | 'whiteout' | 'fixed'

/** fields 配列の上限（サーバ FIELDS_MAX と一致）。20 で「枠を追加」disabled。 */
export const FIELDS_MAX = 20
