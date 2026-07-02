/**
 * renderWithGizirotto — GA7 問題1修正: 会話全体で合計 GIZIROTTO_MAX_TOTAL 個までという
 * 通し番号を alreadyUsed 引数で受け取り、usedInThisText を返す仕様の単体テスト。
 */
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import {
  renderWithGizirotto,
  GIZIROTTO_MAX_TOTAL,
} from '@/components/chat/renderWithGizirotto'

function countIcons(container: HTMLElement): number {
  return container.querySelectorAll('img[alt="ぎじろっと"]').length
}

describe('renderWithGizirotto', () => {
  it('単一テキストに笑顔絵文字 3 個 + alreadyUsed=0 → 2 個置換・3 個目は素のまま・usedInThisText=2', () => {
    const text = '😀こんにちは😊元気ですか😍'
    const result = renderWithGizirotto(text, 0)
    expect(result.usedInThisText).toBe(2)
    const { container } = render(<>{result.node}</>)
    expect(countIcons(container)).toBe(2)
    // 3 個目の絵文字（😍）は置換されず文字列として残っている。
    expect(container.textContent).toContain('😍')
  })

  it('alreadyUsed=2（上限到達） → 0 個置換・usedInThisText=0', () => {
    const text = '😀こんにちは😊'
    const result = renderWithGizirotto(text, GIZIROTTO_MAX_TOTAL)
    expect(result.usedInThisText).toBe(0)
    const { container } = render(<>{result.node}</>)
    expect(countIcons(container)).toBe(0)
    expect(container.textContent).toBe(text)
  })

  it('alreadyUsed=1 + 絵文字 2 個 → 1 個だけ置換（remaining=1）', () => {
    const text = '😀こんにちは😊'
    const result = renderWithGizirotto(text, 1)
    expect(result.usedInThisText).toBe(1)
    const { container } = render(<>{result.node}</>)
    expect(countIcons(container)).toBe(1)
    // 2 個目の絵文字は素のまま残る。
    expect(container.textContent).toContain('😊')
  })

  it('絵文字を含まないテキストは usedInThisText=0・元のテキストがそのまま返る', () => {
    const text = 'こんにちは、元気ですか？'
    const result = renderWithGizirotto(text, 0)
    expect(result.usedInThisText).toBe(0)
    expect(result.node).toBe(text)
  })

  it('空文字は usedInThisText=0・空文字がそのまま返る', () => {
    const result = renderWithGizirotto('', 0)
    expect(result.usedInThisText).toBe(0)
    expect(result.node).toBe('')
  })

  it('対象外の絵文字（泣き顔等）は置換されない', () => {
    const text = '😢悲しいです'
    const result = renderWithGizirotto(text, 0)
    expect(result.usedInThisText).toBe(0)
    expect(result.node).toBe(text)
  })

  it('maxTotal をカスタム指定できる（既定 2 以外の値でも動作）', () => {
    const text = '😀😊😍😎'
    const result = renderWithGizirotto(text, 0, 3)
    expect(result.usedInThisText).toBe(3)
    const { container } = render(<>{result.node}</>)
    expect(countIcons(container)).toBe(3)
  })
})
