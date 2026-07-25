/**
 * LogoutButton unit test
 *
 * モーダル確認経由のフローに更新（設計書: logout_confirm_modal_2026-06-30.md §3）。
 *
 * 検証項目:
 *   1. mount で「ログアウト」ボタンが表示される
 *   2. ボタンクリックで確認モーダルが開く（即 fetch はしない）
 *   3. モーダル「ログアウト」で /api/auth/logout に POST 発火 + push/refresh
 *   4. 401（既ログアウト）も成功扱いで遷移
 *   5. 500 でモーダル内エラー表示 + loading 解除
 *   6. loading 中はモーダル内ボタン disabled + ラベル「ログアウト中…」
 *   7. fetch reject 時もモーダル内エラー表示 + loading 解除
 *   8. キャンセルでモーダルが閉じる
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'

const pushMock = vi.fn()
const refreshMock = vi.fn()
const fetchMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
    replace: vi.fn(),
    refresh: refreshMock,
    back: vi.fn(),
  }),
}))

import { LogoutButton } from '@/app/(dashboard)/settings/_components/LogoutButton'

beforeEach(() => {
  pushMock.mockReset()
  refreshMock.mockReset()
  fetchMock.mockReset()
  global.fetch = fetchMock as unknown as typeof fetch
})

afterEach(() => {
  cleanup()
})

describe('LogoutButton', () => {
  it('mount で「ログアウト」ボタンが表示される', () => {
    render(<LogoutButton />)
    const btn = screen.getByRole('button', { name: 'ログアウト' })
    expect(btn).toBeTruthy()
    expect((btn as HTMLButtonElement).disabled).toBe(false)
  })

  it('ボタンクリックで確認モーダルが開く（fetch はまだ発火しない）', () => {
    render(<LogoutButton />)
    fireEvent.click(screen.getByRole('button', { name: 'ログアウト' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('ログアウトしますか？')).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('モーダル「ログアウト」で /api/auth/logout POST + push/refresh', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )

    render(<LogoutButton />)
    fireEvent.click(screen.getByRole('button', { name: 'ログアウト' }))
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'ログアウト',
      }),
    )

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', {
        method: 'POST',
      })
    })
    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith('/')
      expect(refreshMock).toHaveBeenCalledTimes(1)
    })
  })

  it('401（既ログアウト）も成功扱いで遷移する', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 401 }))

    render(<LogoutButton />)
    fireEvent.click(screen.getByRole('button', { name: 'ログアウト' }))
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'ログアウト',
      }),
    )

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith('/')
      expect(refreshMock).toHaveBeenCalledTimes(1)
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('500 でモーダル内エラー表示 + loading 解除', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 500 }))

    render(<LogoutButton />)
    fireEvent.click(screen.getByRole('button', { name: 'ログアウト' }))
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'ログアウト',
      }),
    )

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('ログアウトに失敗しました')
    // モーダルは開いたまま・確認ボタンが enabled & ラベル戻る
    const confirmBtn = within(screen.getByRole('dialog')).getByRole(
      'button',
      { name: 'ログアウト' },
    ) as HTMLButtonElement
    expect(confirmBtn.disabled).toBe(false)
    expect(pushMock).not.toHaveBeenCalled()
    expect(refreshMock).not.toHaveBeenCalled()
  })

  it('loading 中はモーダル内ボタン disabled + ラベル「ログアウト中…」', async () => {
    let resolveFetch: (v: Response) => void = () => {}
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve
      }),
    )

    render(<LogoutButton />)
    fireEvent.click(screen.getByRole('button', { name: 'ログアウト' }))
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'ログアウト',
      }),
    )

    await waitFor(() => {
      const loadingBtn = screen.getByRole('button', {
        name: 'ログアウト中…',
      }) as HTMLButtonElement
      expect(loadingBtn.disabled).toBe(true)
    })

    resolveFetch(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await waitFor(() => {
      expect(pushMock).toHaveBeenCalled()
    })
  })

  it('fetch が throw した場合もモーダル内エラー表示 + loading 解除', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))

    render(<LogoutButton />)
    fireEvent.click(screen.getByRole('button', { name: 'ログアウト' }))
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'ログアウト',
      }),
    )

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('ログアウトに失敗しました')
    const confirmBtn = within(screen.getByRole('dialog')).getByRole(
      'button',
      { name: 'ログアウト' },
    ) as HTMLButtonElement
    expect(confirmBtn.disabled).toBe(false)
  })

  it('モーダルのキャンセルでモーダルが閉じる', () => {
    render(<LogoutButton />)
    fireEvent.click(screen.getByRole('button', { name: 'ログアウト' }))
    expect(screen.getByRole('dialog')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
