/**
 * LogoutConfirmModal 単体テスト (設計書 §6.1 全 10 ケース)。
 *
 * 設計書: docs/designs/logout_confirm_modal_2026-06-30.md
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { LogoutConfirmModal } from '@/app/(dashboard)/settings/_components/LogoutConfirmModal'

afterEach(() => {
  cleanup()
})

describe('LogoutConfirmModal', () => {
  function noop() {}

  it('#1: open=false で何も描画されない', () => {
    const { container } = render(
      <LogoutConfirmModal open={false} onConfirm={noop} onCancel={noop} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('#2: open=true でタイトル「ログアウトしますか？」が描画される', () => {
    render(<LogoutConfirmModal open onConfirm={noop} onCancel={noop} />)
    expect(screen.getByText('ログアウトしますか？')).toBeTruthy()
  })

  it('#3: open=true で本文と 2 ボタン（はい、ログアウト / キャンセル）が描画される', () => {
    render(<LogoutConfirmModal open onConfirm={noop} onCancel={noop} />)
    expect(
      screen.getByText(
        'ログアウトすると、再びログインするまで議事録の閲覧・編集はできません。',
      ),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'はい、ログアウト' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'キャンセル' })).toBeTruthy()
  })

  it('#4: mount 時にキャンセルボタンへ focus される', () => {
    render(<LogoutConfirmModal open onConfirm={noop} onCancel={noop} />)
    const cancelBtn = screen.getByRole('button', { name: 'キャンセル' })
    expect(document.activeElement).toBe(cancelBtn)
  })

  it('#5: Esc キーで onCancel が呼ばれる', () => {
    const onCancel = vi.fn()
    render(<LogoutConfirmModal open onConfirm={noop} onCancel={onCancel} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('#6: loading=true のとき Esc が無視される', () => {
    const onCancel = vi.fn()
    render(
      <LogoutConfirmModal open loading onConfirm={noop} onCancel={onCancel} />,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('dialog'))
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('#7: 背景クリックで onCancel が呼ばれる', () => {
    const onCancel = vi.fn()
    render(<LogoutConfirmModal open onConfirm={noop} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('dialog'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('#8: パネル内クリックで onCancel が呼ばれない (stopPropagation)', () => {
    const onCancel = vi.fn()
    render(<LogoutConfirmModal open onConfirm={noop} onCancel={onCancel} />)
    // タイトル h3 はパネル内なので親 overlay へバブルしない
    fireEvent.click(screen.getByText('ログアウトしますか？'))
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('#9: 「はい、ログアウト」押下で onConfirm が 1 回呼ばれる', () => {
    const onConfirm = vi.fn()
    render(<LogoutConfirmModal open onConfirm={onConfirm} onCancel={noop} />)
    fireEvent.click(screen.getByRole('button', { name: 'はい、ログアウト' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('#10: error props 渡しで赤背景 role="alert" 表示・aria-busy が loading と同期', () => {
    const { rerender } = render(
      <LogoutConfirmModal
        open
        error="ログアウトに失敗しました。もう一度お試しください。"
        onConfirm={noop}
        onCancel={noop}
      />,
    )
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe(
      'ログアウトに失敗しました。もう一度お試しください。',
    )
    expect(alert.className).toContain('text-red-700')
    expect(alert.className).toContain('bg-red-50')

    // aria-busy=false (loading 未指定時)
    const dialog = screen.getByRole('dialog')
    const panel = dialog.firstElementChild as HTMLElement
    expect(panel.getAttribute('aria-busy')).toBe('false')

    // loading=true で aria-busy=true + ボタン disabled + 文言切替
    rerender(
      <LogoutConfirmModal open loading onConfirm={noop} onCancel={noop} />,
    )
    const dialog2 = screen.getByRole('dialog')
    const panel2 = dialog2.firstElementChild as HTMLElement
    expect(panel2.getAttribute('aria-busy')).toBe('true')
    expect(
      (
        screen.getByRole('button', { name: 'ログアウト中…' }) as HTMLButtonElement
      ).disabled,
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'キャンセル' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })
})
