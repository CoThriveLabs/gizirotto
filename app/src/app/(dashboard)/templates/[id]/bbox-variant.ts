/**
 * bbox 枠の見た目バリアント純関数。
 *
 * BboxPane（記入欄）を白塗りと共用するため、枠/ハンドル/label の className を variant で
 * 出し分ける。座標計算（bbox-coords）・pointer ロジックは variant 非依存で共通＝ズレ温床ゼロ。
 * client component（bbox-pane.tsx）から切り出し、純関数として単体テスト可能にする。
 *
 * 🚨 個人情報死守: whiteout の 30%透過は「編集UI上の表示」だけ。実際の焼き込み（出力DL PDF）は
 *    estimatedBgColor の不透明白で対象領域を完全被覆する（透過は出力に出ない）。
 */

/** 枠の見た目バリアント（見た目のみ・座標非依存）。 */
export type BboxVariant = 'field' | 'whiteout'

/**
 * 白塗りの種別（見た目の破線/実線の出し分けに使う・座標非依存）。
 *   - 'auto_suggestion': 自動検出の候補（未確定の含意）→ **破線**。
 *   - 'manual'         : ユーザー確定 → **実線**。
 * whiteout-pipeline の WhiteoutSource と同義（型 import を避け見た目層で独立定義）。
 */
export type WhiteoutKind = 'auto_suggestion' | 'manual'

/**
 * variant×選択状態 → 枠 div の className。
 *
 * 'field'（記入欄）は段階1完了時の青枠文字列をそのまま返し**完全同一挙動を保証**する。
 * 'whiteout'（白塗り）は**灰色30%枠**（2-A の whiteout-modal と統一）＋選択は ring で示す。
 *   - 第3引数 kind で auto=破線(border-dashed) / manual=実線(border-solid) を出し分ける。
 *     現行実装は灰 30% 枠基準（記入欄の青と差別化するため）。
 *   - kind 省略時は実線（後方互換: 既存テスト/呼び出しは灰実線のまま）。
 *
 * 🚨 個人情報死守: ここでの 30% 透過（bg-gray-400/30）は**編集UI上の見た目だけ**。
 *    実際の焼き込み（出力DL PDF）は applyWhiteout が estimatedBgColor の**不透明白**で
 *    対象領域を完全被覆する（透過は出力に一切出ない）。下の文字位置を編集中に確認するための透過。
 */
export function bboxBoxClass(
  variant: BboxVariant,
  selected: boolean,
  kind?: WhiteoutKind,
): string {
  if (variant === 'whiteout') {
    // auto=破線（候補=未確定）/ manual=実線（確定）。kind 省略時は実線。
    const dash = kind === 'auto_suggestion' ? 'border-dashed' : 'border-solid'
    // 灰色30%枠。選択中は ring で強調（紙背景でも視認しやすい）。
    return selected
      ? `border-gray-600 ${dash} bg-gray-400/40 ring-2 ring-gizirotto-blue-400`
      : `border-gray-500 ${dash} bg-gray-400/30 hover:bg-gray-400/40`
  }
  // 'field'（記入欄）= 段階1 完了時と一字一句同一（無改変保証）。
  return selected
    ? 'border-gizirotto-blue-700 bg-gizirotto-blue-500/20'
    : 'border-gizirotto-blue-500 bg-gizirotto-blue-500/10 hover:bg-gizirotto-blue-500/20'
}

/** variant → リサイズハンドル（小四角）の className。 */
export function bboxHandleClass(variant: BboxVariant): string {
  if (variant === 'whiteout') {
    return 'bg-white border-2 border-gray-600 rounded-sm'
  }
  // 'field' = 段階1 完了時と同一。
  return 'bg-white border-2 border-gizirotto-blue-700 rounded-sm'
}

/** variant → 選択中 label バッジの className。 */
export function bboxLabelClass(variant: BboxVariant): string {
  if (variant === 'whiteout') {
    return 'bg-gray-700 text-white'
  }
  // 'field' = 段階1 完了時と同一。
  return 'bg-gizirotto-blue-700 text-white'
}
