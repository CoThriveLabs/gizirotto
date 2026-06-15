/**
 * uniform 手動上書き値（minute 単位・全項目一括）の純関数群。
 *
 * 永続方針: マイグレーション回避のため、既存 bbox_overrides jsonb に予約キー `__uniform__`
 *   を共存させる。値は `{ fontSize: number }` で FieldOverride 形の partial（既存 zod
 *   fieldOverrideSchema で valid・サーバ改修不要）。
 *
 * 優先順位: 手動上書き > 自動整合（snap） > 素 uniform
 *   → 手動値が非 null の場合、snap をスキップして RANGE クランプのみ適用する。
 *
 * クランプ:
 *   - 編集 UI 側でハードクランプ（範囲外入力時は最近接の境界値に補正・ユーザー通知）。
 *   - 永続値も RANGE_MIN..RANGE_MAX に閉じ込める（読出側でも防御クランプ）。
 *
 * 🚨 クライアント/サーバ共有純関数: サーバ専用 import 一切なし。
 */
import type { BboxOverrides } from './field-override'
import { RANGE_MAX, RANGE_MIN } from './uniform-size'

/**
 * bbox_overrides jsonb 内の予約キー（議事録 1 件あたり 1 個・全項目一括 uniform 手動値）。
 * field 名規則 `field_N` / `ft_N` と衝突しない `__` プレフィックスを採用。
 */
export const UNIFORM_OVERRIDE_KEY = '__uniform__'

/**
 * RANGE_MIN..RANGE_MAX へハードクランプ。NaN / 非有限は null へ落とす（防御）。
 * UI 側の type=number 入力 / ±ボタン両方の最終ガード（範囲外 → 最近接境界）。
 */
export function clampUniformOverridePt(pt: number): number {
  if (!Number.isFinite(pt)) return RANGE_MIN
  return Math.min(RANGE_MAX, Math.max(RANGE_MIN, pt))
}

/**
 * 入力 pt が RANGE 範囲外なら true（UI 側でトースト等の通知を出す判定に使う）。
 */
export function isOutOfRange(pt: number): boolean {
  if (!Number.isFinite(pt)) return true
  return pt < RANGE_MIN || pt > RANGE_MAX
}

/**
 * overrides から `__uniform__` 予約キーの fontSize を取り出す。
 *
 * - 予約キーが無い / fontSize が無い / 不正値 → null（= 自動算出経路を使う）。
 * - 値があれば防御クランプして返す（DB 側で範囲外値が来ても UI で表示する値は範囲内）。
 *
 * @returns 手動上書き値（pt）または null（= 未設定 = 自動算出）。
 */
export function readUniformOverridePt(
  overrides: BboxOverrides | null | undefined,
): number | null {
  if (!overrides) return null
  const entry = overrides[UNIFORM_OVERRIDE_KEY]
  if (!entry) return null
  const v = entry.fontSize
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return clampUniformOverridePt(v)
}

/**
 * overrides に `__uniform__` 予約キーを書き込んだ新 overrides を返す（不変更新）。
 *
 * @param overrides    既存 overrides（不変・元を破壊しない）。
 * @param pt           書き込む値（pt）。null を渡すと予約キーを削除する（自動算出経路へ戻す）。
 * @returns            新 overrides。
 */
export function writeUniformOverridePt(
  overrides: BboxOverrides,
  pt: number | null,
): BboxOverrides {
  const next: BboxOverrides = { ...overrides }
  if (pt === null) {
    if (UNIFORM_OVERRIDE_KEY in next) {
      delete next[UNIFORM_OVERRIDE_KEY]
    }
    return next
  }
  next[UNIFORM_OVERRIDE_KEY] = { fontSize: clampUniformOverridePt(pt) }
  return next
}

/**
 * uniform 値の最終解決（手動 > 自動）の純関数。
 *
 * @param overridePt   手動上書き値（null = 自動算出を使う）。
 * @param computeAuto  自動算出経路（snap 込みの computeUniformFontSize 等）。
 * @returns            最終 uniform fontSize（pt）。両方 null/undefined なら undefined。
 *
 * 手動値が非 null の場合は snap を呼ばず RANGE クランプのみ適用。
 */
export function resolveUniformFontSize(args: {
  overridePt: number | null
  computeAuto: () => number | undefined
}): number | undefined {
  const { overridePt, computeAuto } = args
  if (overridePt !== null) {
    return clampUniformOverridePt(overridePt)
  }
  return computeAuto()
}
