/**
 * AdjustView 動的プレビュー fontSize の field 単位独立性 unit test。
 *
 * 旧バグ: SVG `<text fontSize={... selectedOverride?.fontSize ?? 12}>` を
 *         fields.map ループ内で全 field 共通に参照していたため、
 *         field A を選択して fontSize を 18pt にすると未選択の field B/C/D も 18pt で描画。
 *
 * 修正: 各 field 自身の `overrides[f.name]?.fontSize` を `computePreviewFontSize` に渡す。
 *
 * テスト方針: 描画ロジックの本質である `computePreviewFontSize` 純関数を直接検証。
 *   - 他 field の override.fontSize が当該 field のプレビュー fontSize に影響しないこと
 *     （関数が引数 2 つしか受けないので構造的に独立保証されることを担保）
 *   - bbox.h 上限クランプ（h * 0.7）/ override 指定値 / fallback 12pt の各境界
 *
 * 「動的プレビューは位置・大きさ・折返しの近似」（field 単位独立であるべき）。
 */
import { describe, it, expect } from 'vitest'
import { computePreviewFontSize } from '@/app/(dashboard)/minutes/[id]/adjust/adjust-view-helpers'

describe('computePreviewFontSize', () => {
  it('override.fontSize 指定で bbox.h * 0.7 を下回るときは override 値を使う', () => {
    // bbox.h=40 → upper=28、override=18 < 28 → 18 を採用
    expect(computePreviewFontSize(40, 18)).toBe(18)
  })

  it('override.fontSize が bbox.h * 0.7 上限を超えたら h*0.7 にクランプ', () => {
    // bbox.h=20 → upper=14、override=18 > 14 → 14 を採用（はみ出し防止）
    expect(computePreviewFontSize(20, 18)).toBe(14)
  })

  it('override 未指定（自動）は fallback 12pt と bbox.h*0.7 の小さい方', () => {
    // 大きい bbox: upper=28、fallback 12 < 28 → 12
    expect(computePreviewFontSize(40, undefined)).toBe(12)
    // 小さい bbox: upper=10.5、fallback 12 > 10.5 → 10.5
    expect(computePreviewFontSize(15, undefined)).toBe(10.5)
  })

  it('field A の override.fontSize は field B のプレビュー fontSize に影響しない（差し戻し 1 回帰防止）', () => {
    // シナリオ: field A を 18pt に手動上書き、field B は自動（override 無し）。
    // 純関数は当該 field の値しか受けないため、A の 18 が B の出力に紛れ込む経路は構造的に存在しない。
    const fieldA_h = 30
    const fieldA_override = 18
    const fieldB_h = 30
    const fieldB_override = undefined // field B は override 無し（自動）

    const previewA = computePreviewFontSize(fieldA_h, fieldA_override)
    const previewB = computePreviewFontSize(fieldB_h, fieldB_override)

    // field A は 18pt（bbox.h*0.7=21 より小なので採用）
    expect(previewA).toBe(18)
    // field B は fallback 12pt（A の 18 は影響しない）
    expect(previewB).toBe(12)
    // 念のため A != B（旧バグ時は A も B も 18 で描画されていた）
    expect(previewA).not.toBe(previewB)
  })

  it('field A の override が変動しても field B（自動）のプレビューは不変', () => {
    const h = 50
    // field B のプレビューは A の override に依存しない（純関数性）。
    const b1 = computePreviewFontSize(h, undefined) // A=8 のとき
    const b2 = computePreviewFontSize(h, undefined) // A=18 のとき
    expect(b1).toBe(b2)
    expect(b1).toBe(12) // fallback
  })

  it('境界: override === h * 0.7 のときは override 値（Math.min 等価）', () => {
    expect(computePreviewFontSize(20, 14)).toBe(14)
  })

  it('境界: bbox.h=0 は upper=0 → 全プレビュー描画は呼び側 hasValue で抑止、関数は 0 を返す', () => {
    expect(computePreviewFontSize(0, 18)).toBe(0)
    expect(computePreviewFontSize(0, undefined)).toBe(0)
  })
})
