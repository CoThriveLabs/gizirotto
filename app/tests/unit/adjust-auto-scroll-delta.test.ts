/**
 * computeAutoScrollDelta 純関数の unit test。
 *
 * スマホ用インスペクタ（下部固定モーダル）が選択中 bbox に被さらないよう、
 * 「選択枠の下辺 + minGap」が「モーダルの上辺」を超える分だけスクロールする量を求める。
 */
import { describe, it, expect } from 'vitest'
import { computeAutoScrollDelta } from '@/app/(dashboard)/minutes/[id]/adjust/adjust-view-helpers'

describe('computeAutoScrollDelta', () => {
  it('モーダルが選択枠に被っている場合、不足分をちょうど返す', () => {
    // 選択枠の下辺 1020、モーダル上辺 1010 → 被り 10px。minGap 4px 欲しいので 14px 必要。
    const delta = computeAutoScrollDelta({
      selectionBottom: 1020,
      modalTop: 1010,
      minGap: 4,
    })
    expect(delta).toBe(14)
  })

  it('gap がちょうど minGap のとき 0（スクロール不要）', () => {
    const delta = computeAutoScrollDelta({
      selectionBottom: 1000,
      modalTop: 1004,
      minGap: 4,
    })
    expect(delta).toBe(0)
  })

  it('gap が minGap を超えている場合 0（既に十分な余白）', () => {
    const delta = computeAutoScrollDelta({
      selectionBottom: 900,
      modalTop: 1010,
      minGap: 4,
    })
    expect(delta).toBe(0)
  })

  it('gap が minGap よりわずかに小さい場合、その差分だけ返す', () => {
    const delta = computeAutoScrollDelta({
      selectionBottom: 1000,
      modalTop: 1002, // gap=2
      minGap: 4,
    })
    expect(delta).toBe(2)
  })

  it('選択枠がモーダルよりずっと下（大きくマイナス gap）でも正しい差分を返す', () => {
    const delta = computeAutoScrollDelta({
      selectionBottom: 2000,
      modalTop: 1000, // gap=-1000
      minGap: 4,
    })
    expect(delta).toBe(1004)
  })

  it('minGap=0 のとき、ちょうど接触（gap=0）では 0 を返す', () => {
    const delta = computeAutoScrollDelta({
      selectionBottom: 500,
      modalTop: 500,
      minGap: 0,
    })
    expect(delta).toBe(0)
  })
})
