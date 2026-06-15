/**
 * 議事録出力（Word / PDF）共通ユーティリティ。
 * 各経路で重複していた flattenContent + sanitizeFilename を本ファイルに集約する。
 */

/**
 * content_json を { field_name: string } の flat map に正規化。
 * - null/undefined → 空文字
 * - 配列 → 改行区切り
 * - object/その他 → JSON.stringify
 * - extras（title / meeting_date 等）は呼出側で追加注入（デフォルト空、未指定で省略可）
 */
export function flattenContent(
  raw: unknown,
  extras: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = { ...extras }
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v == null) {
      out[k] = ''
    } else if (typeof v === 'string') {
      out[k] = v
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = String(v)
    } else if (Array.isArray(v)) {
      out[k] = v
        .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
        .join('\n')
    } else {
      out[k] = JSON.stringify(v)
    }
  }
  return out
}

/**
 * download filename 用の sanitize。Windows 禁止文字を _ 置換 + 80 文字以内。
 * 空文字フォールバックは 'minutes'。
 */
export function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'minutes'
}
