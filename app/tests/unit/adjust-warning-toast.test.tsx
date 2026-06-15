/**
 * 案A「ConfirmView 即廃止」設計書（2026-06-10）P4。
 *
 * AdjustView 初回マウント時の minutes:draft-warning → toast 振替の動作検証。
 *
 * 検証観点:
 *   1. sessionStorage に minutes:draft-warning が入っていれば、
 *      AdjustView マウントで useToast().showToast('warning', <msg>) が呼ばれる
 *   2. 同じ key が sessionStorage.removeItem で消費される（2 回目マウントで toast 出ない）
 *   3. sessionStorage に warning が無い場合は showToast が呼ばれない
 *
 * AdjustView 全体を render すると依存が重いため、
 * 初回マウント useEffect ロジックと同型の最小フックを inline 定義して検証する
 * （AdjustView 内のロジックと等価）。
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import { useEffect } from 'react'

type ShowToast = (kind: 'warning', message: string) => void

/** AdjustView §4-1 と同型の初回マウントフック（仕様の単一実装）。 */
function useDraftWarningToast(showToast: ShowToast): void {
  useEffect(() => {
    if (typeof window === 'undefined') return
    const warning = sessionStorage.getItem('minutes:draft-warning')
    if (!warning) return
    sessionStorage.removeItem('minutes:draft-warning')
    showToast('warning', warning)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

function TestComponent({ showToast }: { showToast: ShowToast }) {
  useDraftWarningToast(showToast)
  return <div data-testid="mounted" />
}

describe('AdjustView 初回マウント warning toast 振替（案A P3）', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })
  afterEach(() => {
    cleanup()
    sessionStorage.clear()
  })

  it('minutes:draft-warning あり → showToast(warning, message) が 1 回呼ばれる', () => {
    sessionStorage.setItem(
      'minutes:draft-warning',
      'うまく振り分けられませんでした。',
    )
    const showToast = vi.fn()
    render(<TestComponent showToast={showToast} />)
    expect(showToast).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledWith(
      'warning',
      'うまく振り分けられませんでした。',
    )
  })

  it('minutes:draft-warning が sessionStorage から removeItem で消費される', () => {
    sessionStorage.setItem('minutes:draft-warning', 'x')
    const showToast = vi.fn()
    render(<TestComponent showToast={showToast} />)
    expect(sessionStorage.getItem('minutes:draft-warning')).toBeNull()
  })

  it('warning なし → showToast 呼ばれない（既存議事録閲覧時の誤発火防止）', () => {
    const showToast = vi.fn()
    render(<TestComponent showToast={showToast} />)
    expect(showToast).not.toHaveBeenCalled()
  })

  it('2 回目以降のマウント → 1 回目で consume 済みのため再発火しない', () => {
    sessionStorage.setItem('minutes:draft-warning', 'one-shot')
    const showToast = vi.fn()
    const { unmount } = render(<TestComponent showToast={showToast} />)
    expect(showToast).toHaveBeenCalledTimes(1)
    act(() => {
      unmount()
    })
    // 2 回目マウントでは sessionStorage 既に空なので呼ばれない。
    render(<TestComponent showToast={showToast} />)
    expect(showToast).toHaveBeenCalledTimes(1)
  })
})
