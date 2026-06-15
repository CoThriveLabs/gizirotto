/**
 * 連番を丸数字（①〜⑳）に変換するユーティリティ（G1-⑤案2）。
 * EditForm の extraEntries 総称ラベル「その他の項目①…」で使用。
 *
 * n は 1 始まり。21 以降は丸数字が無いため通常数字へ fallback。
 */
const CIRCLED_DIGITS = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'

export function ordinalLabel(n: number): string {
  if (Number.isInteger(n) && n >= 1 && n <= 20) return CIRCLED_DIGITS[n - 1]
  return String(n)
}
