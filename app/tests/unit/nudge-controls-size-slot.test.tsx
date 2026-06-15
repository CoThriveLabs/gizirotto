/**
 * NudgeControls の sizeSlot prop（段階 2-D2 v2.3 §1-1-0-B 案 B）。
 *
 * - sizeSlot 省略時: 従来の幅±/高さ± が描画される（templates 編集モード後方互換）
 * - sizeSlot 指定時: 第2列の中身が差し替わり、幅±/高さ± が消える（AdjustView 用）
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import NudgeControls from '@/app/(dashboard)/templates/[id]/nudge-controls'

describe('NudgeControls sizeSlot', () => {
  it('sizeSlot 省略時は既存の 幅/高さ ラベルが描画される', () => {
    render(
      <NudgeControls
        disabled={false}
        onNudge={() => {}}
        onCenter={() => {}}
        compact={false}
      />,
    )
    // 既存挙動: 幅と高さ のラベルが見える
    expect(screen.getByText('幅')).toBeTruthy()
    expect(screen.getByText('高さ')).toBeTruthy()
  })

  it('sizeSlot 指定時は渡した ReactNode が第2列に描画され、幅/高さ ラベルは出ない', () => {
    render(
      <NudgeControls
        disabled={false}
        onNudge={() => {}}
        onCenter={() => {}}
        compact={false}
        sizeSlot={<div data-testid="my-size-slot">大きさカスタム</div>}
      />,
    )
    expect(screen.getByTestId('my-size-slot')).toBeTruthy()
    expect(screen.queryByText('幅')).toBeNull()
    expect(screen.queryByText('高さ')).toBeNull()
  })

  it('hideSize=true は sizeSlot より優先（列ごと消える）', () => {
    render(
      <NudgeControls
        disabled={false}
        onNudge={() => {}}
        onCenter={() => {}}
        compact={false}
        hideSize
        sizeSlot={<div data-testid="my-size-slot">カスタム</div>}
      />,
    )
    expect(screen.queryByTestId('my-size-slot')).toBeNull()
    expect(screen.queryByText('幅')).toBeNull()
  })
})
