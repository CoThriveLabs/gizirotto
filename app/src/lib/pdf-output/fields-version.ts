/**
 * fields の決定的シリアライズ + ハッシュ（楽観ロック用 fieldsVersion）。
 * G2-1 設計書 v0.2 §4-3。
 *
 * templates に updated_at 列が無いため（§1-5）、列追加せず fields スナップショットの
 * ハッシュ比較で楽観ロックを実装する。取得時に fieldsVersion を返し、保存時に同送 →
 * 保存直前に現 DB fields を再取得しハッシュ再計算、不一致なら CONFLICT。
 *
 * 決定的シリアライズ（stableStringify）は純粋関数（unit テスト対象）。
 * ハッシュ計算（computeFieldsVersion）は node:crypto を使うサーバー専用。
 */
import { createHash } from 'node:crypto'

/**
 * キー順に依存しない決定的 JSON シリアライズ。
 * オブジェクトのキーを再帰的にソートしてから JSON 化する。
 * 配列の順序は保持（fields の並び順は意味を持つため）。
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value))
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep)
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeysDeep(obj[key])
    }
    return sorted
  }
  return value
}

/**
 * fields の決定的シリアライズを sha256 した hex 文字列。
 * 取得時・保存直前で同じ入力に対し同じ値を返す（順序非依存）。
 */
export function computeFieldsVersion(fields: unknown): string {
  return createHash('sha256').update(stableStringify(fields)).digest('hex')
}
