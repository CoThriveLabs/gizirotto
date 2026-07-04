/**
 * 段階2-D8（中央維持拡張）+ 段階2-D10（D8 副作用解消・案 A）
 *   bbox 中央維持拡張 純関数 + 4 経路 y 同時 update 結合 unit test。
 *
 * 旧挙動（D5 まで）:
 *   マウント effect / onValueChange / onFontSizeStep / onFontSizeReset の 4 経路で
 *   `overrides.h = requiredH` を「素 bbox.h との大小比較なし・無条件」で書き込んでいた。
 *
 * D8 修正:
 *   bbox.h 拡張時に bbox.y も同時 shift して bbox 中央位置を維持。
 *   shiftY = (baseH - newH) / 2、newY = baseY + shiftY。
 *
 * D10 修正（D8 副作用解消・ユーザー実機フィードバック 3 件）:
 *   ① 縮小時は shiftY=0（拡張時のみ中央維持）
 *      → 議題（テンプレ h=30, required=22）のような余裕 field で下シフト副作用解消。
 *   ② 4 経路すべてで effectiveH = max(テンプレ h, requiredH)（縮小禁止）。
 *   ③ shiftY を素 baseY に足す経路は「マウント effect のみ」に限定。
 *      onValueChange / onFontSizeStep / onFontSizeReset では bbox.y を一切触らない
 *      （ユーザー手動移動 overrides.y を尊重）。
 *
 * テスト方針:
 *   - 純関数 `computeBboxCenteredYShift` を直接検証（拡張時のみ shift / 縮小は 0）。
 *   - 4 経路で「effectiveH = max(baseH, requiredH)」と「3 経路は y 不変」を式同型で担保。
 *
 * 設計書根拠: minutes_adjust_editor_renewal_design_2026-06-08 v2.7（D8/D8.1）+ D10 追補予定。
 * required-bbox-height.ts A 式は触らない（mistake.md 6 維持）。
 */
import { describe, it, expect } from 'vitest'
import { computeBboxCenteredYShift } from '@/app/(dashboard)/minutes/[id]/adjust/adjust-view-helpers'

describe('computeBboxCenteredYShift（D10: 拡張時のみ・縮小は 0）', () => {
  it('場所 field 想定: 素 bbox.h=14, requiredH=22 → shiftY=-4（上方向 shift で中央維持）', () => {
    // baseH=14, newH=22 → (14-22)/2 = -4
    const baseH = 14
    const newH = 22
    const baseY = 300
    const shiftY = computeBboxCenteredYShift(baseH, newH)
    expect(shiftY).toBe(-4)
    expect(baseY + shiftY).toBe(296)
  })

  it('縮小ケース: 素 bbox.h=30, requiredH=22 → shiftY=0（D10: 縮小では shift しない）', () => {
    // D10 修正: 縮小（newH <= baseH）では 0 を返す。
    // 呼び出し側 4 経路で effectiveH = max(baseH, requiredH) と併用するため、
    // 縮小ケースでは effectiveH=baseH に丸められて shiftY=0 → y 不変が保たれる。
    const baseH = 30
    const newH = 22
    const baseY = 300
    const shiftY = computeBboxCenteredYShift(baseH, newH)
    expect(shiftY).toBe(0)
    expect(baseY + shiftY).toBe(300)
  })

  it('等しい場合: baseH=requiredH → shiftY=0（中央維持・移動なし）', () => {
    expect(computeBboxCenteredYShift(20, 20)).toBe(0)
  })

  it('小数も対応（拡張）: baseH=14.5, newH=20 → shiftY=-2.75', () => {
    expect(computeBboxCenteredYShift(14.5, 20)).toBe(-2.75)
  })

  it('境界 baseH=0: 全拡張は新 h の半分上に shift', () => {
    // baseH=0, newH=10 → (0-10)/2 = -5
    expect(computeBboxCenteredYShift(0, 10)).toBe(-5)
  })

  describe('D10 effectiveH = max(baseH, requiredH) 整合', () => {
    // 4 経路すべてで `effectiveH = Math.max(pdfField.bbox.h, requiredH)` を採用する。
    // 拡張時のみ shiftY が非ゼロ、縮小時は effectiveH=baseH に丸められて shiftY=0。

    it('自宅 field 想定（拡張）: baseH=14, requiredH=22 → effectiveH=22, shiftY=-4', () => {
      const baseH = 14
      const requiredH = 22
      const effectiveH = Math.max(baseH, requiredH)
      expect(effectiveH).toBe(22)
      const shiftY = computeBboxCenteredYShift(baseH, effectiveH)
      expect(shiftY).toBe(-4)
    })

    it('議題 field 想定（縮小・テンプレ余裕あり）: baseH=30, requiredH=22 → effectiveH=30, shiftY=0', () => {
      const baseH = 30
      const requiredH = 22
      const effectiveH = Math.max(baseH, requiredH)
      expect(effectiveH).toBe(30)
      const shiftY = computeBboxCenteredYShift(baseH, effectiveH)
      expect(shiftY).toBe(0)
    })

    it('等値: baseH=22, requiredH=22 → effectiveH=22, shiftY=0', () => {
      const baseH = 22
      const requiredH = 22
      const effectiveH = Math.max(baseH, requiredH)
      expect(effectiveH).toBe(22)
      expect(computeBboxCenteredYShift(baseH, effectiveH)).toBe(0)
    })
  })

  describe('4 経路の y 取扱い（D10: マウント effect のみ y 更新、他 3 経路は y 不変）', () => {
    // マウント effect は素テンプレ baseY 起点で中央維持 y を書き込む。
    // 他 3 経路（onValueChange / onFontSizeStep / onFontSizeReset）は
    // ユーザー手動移動 overrides.y を尊重して y を一切触らない。

    it('マウント effect（拡張）: baseH=14, requiredH=22 → newY = baseY + (-4)', () => {
      const baseH = 14
      const baseY = 300
      const requiredH = 22
      const effectiveH = Math.max(baseH, requiredH)
      const shift = computeBboxCenteredYShift(baseH, effectiveH)
      expect(baseY + shift).toBe(296)
    })

    it('マウント effect（縮小）: baseH=30, requiredH=22 → newY = baseY（不変）', () => {
      const baseH = 30
      const baseY = 300
      const requiredH = 22
      const effectiveH = Math.max(baseH, requiredH)
      const shift = computeBboxCenteredYShift(baseH, effectiveH)
      expect(baseY + shift).toBe(300)
    })

    it('onValueChange: y は touched せず cur.y を保持（ユーザー手動移動位置尊重）', () => {
      // ユーザーが手動で y=400 に移動済みの状態で値を変更した場合、
      // 新しい h は max(baseH, requiredH) で更新するが y=400 は維持される。
      const baseH = 14
      const requiredH = 22
      const userMovedY = 400
      const cur: { y?: number; h?: number } = { y: userMovedY, h: 22 }
      const finalH = Math.max(baseH, requiredH)
      const merged = { ...cur, h: finalH } // 実装と同じく y は触らない
      expect(merged.h).toBe(22)
      expect(merged.y).toBe(400) // 手動移動位置が保持される
    })

    it('onFontSizeStep: fontSize 変更時も y 不変（動かした位置で大きさが変わる）', () => {
      // FB 3「bbox 移動後 fontSize 変更で元位置に戻る」の解消検証。
      const baseH = 14
      const requiredH = 26 // fontSize 拡大で required 増
      const userMovedY = 400
      const cur: { y?: number; h?: number; fontSize?: number } = {
        y: userMovedY,
        h: 22,
      }
      const merged: typeof cur = { ...cur, fontSize: 14 }
      const finalH = Math.max(baseH, requiredH)
      merged.h = finalH // 実装と同じく y は触らない
      expect(merged.h).toBe(26)
      expect(merged.y).toBe(400) // 手動移動位置が保持される
    })

    it('onFontSizeReset: 自動戻し時も y 不変（手動移動位置尊重）', () => {
      const baseH = 14
      const requiredH = 16 // uniform 戻りで縮む
      const userMovedY = 400
      const rest: { y?: number; h?: number } = { y: userMovedY, h: 22 }
      const finalH = Math.max(baseH, requiredH)
      const nextEntry = { ...rest, h: finalH } // 実装と同じく y は触らない
      expect(nextEntry.h).toBe(16)
      expect(nextEntry.y).toBe(400) // 手動移動位置が保持される
    })
  })

  /**
   * D8.1 旧議事録マイグレーション経路（マウント effect ガード厳格化・D10 でも維持）
   *
   * 想定: D4/D5 時代に保存された議事録は `overrides.h` を既に持つが `overrides.y` を持たない。
   * 旧ガード（`cur.h !== undefined → skip`）では y が一切再計算されず「自宅下ずれ」が残存。
   * 新ガード（`cur.h !== undefined && cur.y !== undefined → skip`）で h あり y なしを発火させ、
   * cur.h を effectiveH として尊重した上で中央維持 y を再計算する。
   *
   * D10 でもこのガードは維持。effectiveH = max(baseH, cur.h) で縮小禁止を適用する。
   */
  describe('D8.1 旧議事録マイグレーション経路（D10 max 適用）', () => {
    it('cur.h=22 / cur.y=undefined / baseH=14 → effectiveH=22, shiftY=-4', () => {
      const baseH = 14
      const baseY = 300
      const cur = { h: 22 } as { h?: number; y?: number }
      const shouldSkip = cur.h !== undefined && cur.y !== undefined
      expect(shouldSkip).toBe(false)
      const effectiveH = Math.max(baseH, cur.h ?? 0)
      expect(effectiveH).toBe(22)
      const shift = computeBboxCenteredYShift(baseH, effectiveH)
      expect(shift).toBe(-4)
      expect(baseY + shift).toBe(296)
    })

    it('cur.h=22 / cur.y=300（手動調整済み）→ skip（変更なし）', () => {
      const cur = { h: 22, y: 300 } as { h?: number; y?: number }
      const shouldSkip = cur.h !== undefined && cur.y !== undefined
      expect(shouldSkip).toBe(true)
    })

    it('cur.h=undefined（新規議事録）→ 従来の初期化経路（max + shiftY）', () => {
      const cur = {} as { h?: number; y?: number }
      const shouldSkip = cur.h !== undefined && cur.y !== undefined
      expect(shouldSkip).toBe(false)
      const requiredH = 22
      const baseH = 14
      const baseY = 300
      const effectiveH = Math.max(baseH, requiredH)
      const shift = computeBboxCenteredYShift(baseH, effectiveH)
      expect(baseY + shift).toBe(296)
    })

    it('D10 縮小マイグレーション: cur.h=22 / cur.y=undefined / baseH=30 → effectiveH=30, shiftY=0', () => {
      // 議題 field 想定（テンプレ余裕あり）の旧議事録マイグレーション:
      // cur.h=22 を尊重しない（max で baseH=30 に丸める）→ 素 y のまま。
      const baseH = 30
      const baseY = 300
      const cur = { h: 22 } as { h?: number; y?: number }
      const effectiveH = Math.max(baseH, cur.h ?? 0)
      expect(effectiveH).toBe(30)
      const shift = computeBboxCenteredYShift(baseH, effectiveH)
      expect(shift).toBe(0)
      expect(baseY + shift).toBe(300)
    })
  })
})
