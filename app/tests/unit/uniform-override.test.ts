/**
 * uniform-override（全体の文字サイズ手動上書き）unit test。
 *
 * 検証ポイント:
 *   1. read/write 純関数 round-trip + 後方互換（予約キー無しの旧データ → null）
 *   2. clampUniformOverridePt が RANGE 内に閉じ込める
 *   3. isOutOfRange の境界判定
 *   4. resolveUniformFontSize: 手動値非 null → 手動値（snap スキップ）
 *   5. resolveUniformFontSize: 手動値 null → 自動算出経路（computeAuto を呼ぶ）
 *   6. 「自動に戻す」（pt=null）→ 予約キー削除（後続 read で null）
 *   7. zod 互換性: writeUniformOverridePt の戻り値は既存 fieldOverrideSchema を通る
 *      （`{fontSize: number}` partial）。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  UNIFORM_OVERRIDE_KEY,
  clampUniformOverridePt,
  isOutOfRange,
  readUniformOverridePt,
  resolveUniformFontSize,
  writeUniformOverridePt,
} from '@/lib/pdf-output/uniform-override'
import { RANGE_MAX, RANGE_MIN } from '@/lib/pdf-output/uniform-size'
import { parseFieldOverrides, type BboxOverrides } from '@/lib/pdf-output/field-override'

describe('UNIFORM_OVERRIDE_KEY', () => {
  it('予約キーは `__uniform__`（field 命名規則 field_N / ft_N と衝突しない）', () => {
    expect(UNIFORM_OVERRIDE_KEY).toBe('__uniform__')
    expect(UNIFORM_OVERRIDE_KEY.startsWith('__')).toBe(true)
  })
})

describe('clampUniformOverridePt（ハードクランプ）', () => {
  it('RANGE_MIN/MAX 内はそのまま', () => {
    expect(clampUniformOverridePt(9)).toBe(9)
    expect(clampUniformOverridePt(12)).toBe(12)
    expect(clampUniformOverridePt(18)).toBe(18)
  })
  it('下限を割れば RANGE_MIN', () => {
    expect(clampUniformOverridePt(0)).toBe(RANGE_MIN)
    expect(clampUniformOverridePt(-100)).toBe(RANGE_MIN)
    expect(clampUniformOverridePt(8.9)).toBe(RANGE_MIN)
  })
  it('上限を超えれば RANGE_MAX', () => {
    expect(clampUniformOverridePt(19)).toBe(RANGE_MAX)
    expect(clampUniformOverridePt(100)).toBe(RANGE_MAX)
  })
  it('NaN / 非有限 は RANGE_MIN フォールバック（防御・Number.isFinite=false 共通）', () => {
    expect(clampUniformOverridePt(NaN)).toBe(RANGE_MIN)
    expect(clampUniformOverridePt(Infinity)).toBe(RANGE_MIN)
    expect(clampUniformOverridePt(-Infinity)).toBe(RANGE_MIN)
  })
})

describe('isOutOfRange', () => {
  it('境界値（RANGE_MIN / RANGE_MAX）は範囲内', () => {
    expect(isOutOfRange(RANGE_MIN)).toBe(false)
    expect(isOutOfRange(RANGE_MAX)).toBe(false)
    expect(isOutOfRange(12)).toBe(false)
  })
  it('境界外は true', () => {
    expect(isOutOfRange(RANGE_MIN - 0.1)).toBe(true)
    expect(isOutOfRange(RANGE_MAX + 0.1)).toBe(true)
    expect(isOutOfRange(0)).toBe(true)
    expect(isOutOfRange(100)).toBe(true)
  })
  it('NaN は true（防御）', () => {
    expect(isOutOfRange(NaN)).toBe(true)
  })
})

describe('readUniformOverridePt（後方互換）', () => {
  it('空 overrides → null', () => {
    expect(readUniformOverridePt({})).toBeNull()
    expect(readUniformOverridePt(null)).toBeNull()
    expect(readUniformOverridePt(undefined)).toBeNull()
  })
  it('予約キー無しの旧データ → null（既存議事録の挙動を破壊しない）', () => {
    const legacy: BboxOverrides = {
      field_1: { x: 100, y: 200 },
      field_2: { fontSize: 14 },
    }
    expect(readUniformOverridePt(legacy)).toBeNull()
  })
  it('予約キー有り → fontSize を返す', () => {
    const o: BboxOverrides = { [UNIFORM_OVERRIDE_KEY]: { fontSize: 12 } }
    expect(readUniformOverridePt(o)).toBe(12)
  })
  it('予約キー有り＋他 field の override と共存', () => {
    const o: BboxOverrides = {
      field_1: { x: 100, y: 200 },
      [UNIFORM_OVERRIDE_KEY]: { fontSize: 15 },
    }
    expect(readUniformOverridePt(o)).toBe(15)
  })
  it('予約キー有りだが fontSize 欠損 → null', () => {
    const o: BboxOverrides = { [UNIFORM_OVERRIDE_KEY]: {} }
    expect(readUniformOverridePt(o)).toBeNull()
  })
  it('範囲外の永続値は防御クランプして返す（UI 表示値は常に範囲内）', () => {
    const o: BboxOverrides = { [UNIFORM_OVERRIDE_KEY]: { fontSize: 30 } }
    expect(readUniformOverridePt(o)).toBe(RANGE_MAX)
  })
})

describe('writeUniformOverridePt（不変更新）', () => {
  it('未設定 overrides に予約キーを追加', () => {
    const next = writeUniformOverridePt({}, 12)
    expect(next).toEqual({ [UNIFORM_OVERRIDE_KEY]: { fontSize: 12 } })
  })
  it('既存 field override と共存', () => {
    const prev: BboxOverrides = { field_1: { x: 1, y: 2 } }
    const next = writeUniformOverridePt(prev, 14)
    expect(next.field_1).toEqual({ x: 1, y: 2 })
    expect(next[UNIFORM_OVERRIDE_KEY]).toEqual({ fontSize: 14 })
  })
  it('範囲外値はクランプして書き込まれる（永続値の保護）', () => {
    const next = writeUniformOverridePt({}, 30)
    expect(next[UNIFORM_OVERRIDE_KEY]).toEqual({ fontSize: RANGE_MAX })
  })
  it('pt=null で「自動に戻す」→ 予約キー削除', () => {
    const prev: BboxOverrides = {
      field_1: { x: 1 },
      [UNIFORM_OVERRIDE_KEY]: { fontSize: 12 },
    }
    const next = writeUniformOverridePt(prev, null)
    expect(next[UNIFORM_OVERRIDE_KEY]).toBeUndefined()
    expect(next.field_1).toEqual({ x: 1 })
    // 後続 read で null（自動経路へ戻る）
    expect(readUniformOverridePt(next)).toBeNull()
  })
  it('元 overrides を破壊しない（不変更新）', () => {
    const prev: BboxOverrides = { field_1: { x: 1 } }
    const snapshot = JSON.stringify(prev)
    writeUniformOverridePt(prev, 12)
    expect(JSON.stringify(prev)).toBe(snapshot)
  })
})

describe('resolveUniformFontSize（優先順位: 手動 > 自動）', () => {
  it('手動値が非 null → 手動値を返し、自動算出（computeAuto）は呼ばれない（snap スキップ）', () => {
    const computeAuto = vi.fn(() => 14)
    const result = resolveUniformFontSize({
      overridePt: 12,
      computeAuto,
    })
    expect(result).toBe(12)
    expect(computeAuto).not.toHaveBeenCalled()
  })
  it('手動値 null → 自動算出経路（computeAuto）を通る', () => {
    const computeAuto = vi.fn(() => 14)
    const result = resolveUniformFontSize({
      overridePt: null,
      computeAuto,
    })
    expect(result).toBe(14)
    expect(computeAuto).toHaveBeenCalledTimes(1)
  })
  it('手動値が範囲外でもクランプして返す（snap スキップ + RANGE クランプ）', () => {
    const computeAuto = vi.fn(() => 14)
    const result = resolveUniformFontSize({
      overridePt: 30,
      computeAuto,
    })
    expect(result).toBe(RANGE_MAX)
    expect(computeAuto).not.toHaveBeenCalled()
  })
  it('「自動に戻す」で null → 次回 resolve は自動経路', () => {
    // 状態遷移シミュレーション: 手動 → null（リセット）→ 自動
    const computeAuto = vi.fn(() => 13)
    expect(
      resolveUniformFontSize({ overridePt: 16, computeAuto }),
    ).toBe(16)
    expect(computeAuto).not.toHaveBeenCalled()
    expect(
      resolveUniformFontSize({ overridePt: null, computeAuto }),
    ).toBe(13)
    expect(computeAuto).toHaveBeenCalledTimes(1)
  })
  it('自動算出も undefined（previewFont 未ロード等）→ undefined', () => {
    const result = resolveUniformFontSize({
      overridePt: null,
      computeAuto: () => undefined,
    })
    expect(result).toBeUndefined()
  })
})

describe('bbox_overrides jsonb 互換（既存 zod fieldOverrideSchema が予約キーを破壊しない）', () => {
  it('parseFieldOverrides 経由でも予約キーは保持される', () => {
    // サーバ側 zod schema は z.record(string, fieldOverrideSchema) で `__uniform__` も valid。
    // クライアント側 parseFieldOverrides も fontSize を保持するため round-trip 成立。
    const raw = {
      field_1: { x: 100, y: 200 },
      [UNIFORM_OVERRIDE_KEY]: { fontSize: 13 },
    }
    const parsed = parseFieldOverrides(raw)
    expect(parsed[UNIFORM_OVERRIDE_KEY]).toEqual({ fontSize: 13 })
    expect(readUniformOverridePt(parsed)).toBe(13)
  })
  it('parseFieldOverrides が予約キーの不正値（負・0）を欠損扱いにする', () => {
    const raw = {
      [UNIFORM_OVERRIDE_KEY]: { fontSize: -5 },
    }
    const parsed = parseFieldOverrides(raw)
    // fontSize >0 のみ採用される（field-override.ts の isFiniteNumber+正数チェック）。
    // → 予約キーエントリは空オブジェクト（noise）として除外。
    expect(parsed[UNIFORM_OVERRIDE_KEY]).toBeUndefined()
    expect(readUniformOverridePt(parsed)).toBeNull()
  })
})
