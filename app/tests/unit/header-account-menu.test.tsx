/**
 * HeaderAccountMenu 単体テスト (設計書 §9.1 / 依頼書 §5.1 全 12 ケース)。
 *
 * 設計書: docs/designs/header_account_menu_2026-06-30.md
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

const pushMock = vi.fn()
const refreshMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
    replace: vi.fn(),
    refresh: refreshMock,
    back: vi.fn(),
  }),
}))

import { HeaderAccountMenu } from '@/components/HeaderAccountMenu'

beforeEach(() => {
  pushMock.mockReset()
  refreshMock.mockReset()
  global.fetch = vi.fn() as unknown as typeof fetch
})

afterEach(() => {
  cleanup()
})

describe('HeaderAccountMenu — displayName 空文字（family 未参加ログイン済み）', () => {
  it('トリガーの aria-label は「アカウントメニューを開く」（壊れたラベルにならない）、アバターは ● を表示', () => {
    render(<HeaderAccountMenu displayName="" />)
    const trigger = screen.getByRole('button', { name: 'アカウントメニューを開く' })
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.textContent).toBe('●')
  })
})

describe('HeaderAccountMenu', () => {
  it('#1: displayName を渡すとアバターボタン描画 (aria-haspopup=menu / aria-expanded=false)', () => {
    render(<HeaderAccountMenu displayName="テスト太郎" />)
    const trigger = screen.getByRole('button', {
      name: 'テスト太郎 のアカウントメニューを開く',
    })
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('#2: ボタンクリックで panel 開く (aria-expanded=true)', () => {
    render(<HeaderAccountMenu displayName="テスト太郎" />)
    const trigger = screen.getByRole('button', {
      name: 'テスト太郎 のアカウントメニューを開く',
    })
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('menu', { name: 'アカウントメニュー' })).toBeTruthy()
  })

  it('#3: panel 内に 4 項目描画 (家族メンバー / 設定 / ログアウト / 退会はこちらから)', () => {
    render(<HeaderAccountMenu displayName="テスト太郎" />)
    fireEvent.click(
      screen.getByRole('button', { name: 'テスト太郎 のアカウントメニューを開く' }),
    )
    const items = screen.getAllByRole('menuitem')
    expect(items).toHaveLength(4)
    expect(items[0].textContent).toBe('家族メンバー')
    expect(items[1].textContent).toBe('設定')
    expect(items[2].textContent).toBe('ログアウト')
    expect(items[3].textContent).toBe('退会はこちらから')
  })

  it('#4: 「家族メンバー」リンクが /members を href に持つ', () => {
    render(<HeaderAccountMenu displayName="テスト太郎" />)
    fireEvent.click(
      screen.getByRole('button', { name: 'テスト太郎 のアカウントメニューを開く' }),
    )
    const link = screen.getByRole('menuitem', { name: '家族メンバー' })
    expect(link.getAttribute('href')).toBe('/members')
  })

  it('#5: 「設定」リンクが /settings を href に持つ', () => {
    render(<HeaderAccountMenu displayName="テスト太郎" />)
    fireEvent.click(
      screen.getByRole('button', { name: 'テスト太郎 のアカウントメニューを開く' }),
    )
    const link = screen.getByRole('menuitem', { name: '設定' })
    expect(link.getAttribute('href')).toBe('/settings')
  })

  it('#6: 「退会はこちらから」リンクが /settings#delete-account を href に持つ', () => {
    render(<HeaderAccountMenu displayName="テスト太郎" />)
    fireEvent.click(
      screen.getByRole('button', { name: 'テスト太郎 のアカウントメニューを開く' }),
    )
    const link = screen.getByRole('menuitem', { name: '退会はこちらから' })
    expect(link.getAttribute('href')).toBe('/settings#delete-account')
  })

  it('#7: 「ログアウト」項目クリックで panel 閉じる + LogoutConfirmModal 表示', () => {
    render(<HeaderAccountMenu displayName="テスト太郎" />)
    const trigger = screen.getByRole('button', {
      name: 'テスト太郎 のアカウントメニューを開く',
    })
    fireEvent.click(trigger)
    const logoutItem = screen.getByRole('menuitem', { name: 'ログアウト' })
    fireEvent.click(logoutItem)
    // panel 閉じる
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('menu')).toBeNull()
    // モーダル表示
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('ログアウトしますか？')).toBeTruthy()
  })

  it('#8: LogoutConfirmModal の onCancel で modal 閉じる (ドロップダウンは再表示しない)', () => {
    render(<HeaderAccountMenu displayName="テスト太郎" />)
    fireEvent.click(
      screen.getByRole('button', { name: 'テスト太郎 のアカウントメニューを開く' }),
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'ログアウト' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    // ドロップダウンは再表示しない
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('#9: Esc キーで panel 閉じる + トリガーボタンへ focus が戻る', () => {
    render(<HeaderAccountMenu displayName="テスト太郎" />)
    const trigger = screen.getByRole('button', {
      name: 'テスト太郎 のアカウントメニューを開く',
    })
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('#10: 外側 pointerdown (document body) で panel 閉じる', () => {
    render(<HeaderAccountMenu displayName="テスト太郎" />)
    const trigger = screen.getByRole('button', {
      name: 'テスト太郎 のアカウントメニューを開く',
    })
    fireEvent.click(trigger)
    expect(screen.getByRole('menu')).toBeTruthy()
    // body 上の pointerdown
    fireEvent.pointerDown(document.body)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('#11: panel 内クリックで panel 閉じない', () => {
    render(<HeaderAccountMenu displayName="テスト太郎" />)
    fireEvent.click(
      screen.getByRole('button', { name: 'テスト太郎 のアカウントメニューを開く' }),
    )
    const panel = screen.getByRole('menu', { name: 'アカウントメニュー' })
    fireEvent.pointerDown(panel)
    expect(screen.queryByRole('menu')).not.toBeNull()
  })

  it('#12: トリガー連打で panel が開閉トグルする', () => {
    render(<HeaderAccountMenu displayName="テスト太郎" />)
    const trigger = screen.getByRole('button', {
      name: 'テスト太郎 のアカウントメニューを開く',
    })
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
  })
})
