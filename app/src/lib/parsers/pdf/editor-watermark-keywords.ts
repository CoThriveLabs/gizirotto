/**
 * PDF 編集ツール試用版表示の検出キーワード辞書。
 *
 * 本辞書に該当する文字列が含まれる領域は fields 候補から除外される
 * （PDF ファイル本体には絶対に触らない無加工原則）。
 *
 * 運用追加ルール:
 *   - 運用観測 / ユーザー報告で追加キーワード発見時は本ファイルに追記
 *   - 名前付きシリーズ（Wondershare 系 / Adobe 系 / Foxit 系）はベンダー名で十分カバー
 *
 * 重要:
 *   - 本ファイル / 関数名 / コメント / commit message に PF 公開時の検索ヒット予防対象
 *     ワードを絶対に含めない
 *   - 関数名は `extractEditorWatermarkRegions` / `filterEditorWatermarks` 等で統一
 */
export const EDITOR_WATERMARK_KEYWORDS = [
  '試用版',
  'Trial',
  'DEMO',
  'Demo Version',
  'PDFelement',
  'Wondershare',
  'Acrobat Pro Trial',
  'Adobe Acrobat Trial',
  'Foxit Trial',
  'Foxit Phantom',
  'Made with',
  'Created with',
  'Evaluation Copy',
  'Unregistered',
] as const

export type EditorWatermarkKeyword = (typeof EDITOR_WATERMARK_KEYWORDS)[number]
