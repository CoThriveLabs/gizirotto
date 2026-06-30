/**
 * DeleteAccountModal UI unit test
 *
 * 検証項目:
 *   1. DELETE 未入力で削除ボタン disabled
 *   2. DELETE 入力 + password 入力で enabled
 *   3. hasPassword=false で password 欄が表示されない
 *   4. WRONG_PASSWORD レスポンスでエラー表示
 *   5. SOLE_ADMIN_BLOCKED でケース B 文言に切替 (削除ボタン非表示)
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  previewMock: vi.fn(),
  deleteMock: vi.fn(),
  signOutMock: vi.fn(),
}))

vi.mock('@/server/account', () => ({
  previewDeleteCase: mocks.previewMock,
  deleteMyAccount: mocks.deleteMock,
}))

vi.mock('@/lib/supabase/client', () => ({
  createSupabaseBrowserClient: () => ({
    auth: {
      signOut: mocks.signOutMock,
    },
  }),
}))

// JSDOM では window.location.href への代入が "Not implemented: navigation" エラーを
// 投げるため、href プロパティを書き換え可能にして無害化する。
beforeEach(() => {
  vi.clearAllMocks()
  mocks.signOutMock.mockResolvedValue({ error: null })
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { href: 'http://localhost/settings' },
  })
})

import { DeleteAccountModal } from '@/app/(dashboard)/settings/_components/DeleteAccountModal'

async function mount(
  caseId: 'A' | 'B' | 'C',
  hasPassword: boolean,
  familyName: string | null = 'テスト家族',
) {
  mocks.previewMock.mockResolvedValue({
    ok: true,
    case: caseId,
    familyName,
    hasPassword,
  })
  const onClose = vi.fn()
  render(<DeleteAccountModal onClose={onClose} />)
  // mount 時の preview await が解決するのを待つ
  await waitFor(() => {
    expect(mocks.previewMock).toHaveBeenCalled()
  })
  return { onClose }
}

describe('DeleteAccountModal', () => {
  it('DELETE 未入力で削除ボタンが disabled', async () => {
    await mount('A', true)
    const btn = await screen.findByRole('button', { name: '削除を実行' })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
  })

  it('DELETE + password 入力で enabled になる', async () => {
    await mount('A', true)
    const confirm = await screen.findByLabelText(/DELETE と入力/)
    const password = await screen.findByLabelText(/現在のパスワード/)
    fireEvent.change(confirm, { target: { value: 'DELETE' } })
    fireEvent.change(password, { target: { value: 'pw123' } })
    const btn = screen.getByRole('button', { name: '削除を実行' })
    await waitFor(() => {
      expect((btn as HTMLButtonElement).disabled).toBe(false)
    })
  })

  it('hasPassword=false ならパスワード欄が表示されない', async () => {
    await mount('A', false)
    await screen.findByRole('button', { name: '削除を実行' })
    expect(screen.queryByLabelText(/現在のパスワード/)).toBeNull()
    // DELETE だけで enabled になる
    const confirm = screen.getByLabelText(/DELETE と入力/)
    fireEvent.change(confirm, { target: { value: 'DELETE' } })
    const btn = screen.getByRole('button', { name: '削除を実行' })
    await waitFor(() => {
      expect((btn as HTMLButtonElement).disabled).toBe(false)
    })
  })

  it('WRONG_PASSWORD レスポンスでエラー表示', async () => {
    await mount('A', true)
    mocks.deleteMock.mockResolvedValue({ ok: false, code: 'WRONG_PASSWORD' })

    fireEvent.change(await screen.findByLabelText(/DELETE と入力/), {
      target: { value: 'DELETE' },
    })
    fireEvent.change(screen.getByLabelText(/現在のパスワード/), {
      target: { value: 'bad' },
    })
    fireEvent.click(screen.getByRole('button', { name: '削除を実行' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('パスワードが違います')
  })

  it('SOLE_ADMIN_BLOCKED でケース B 文言に切替 + 削除ボタン非表示', async () => {
    // ケース A で開始 → サーバが SOLE_ADMIN_BLOCKED を返す → B にフォールバック
    await mount('A', true)
    mocks.deleteMock.mockResolvedValue({
      ok: false,
      code: 'SOLE_ADMIN_BLOCKED',
    })

    fireEvent.change(await screen.findByLabelText(/DELETE と入力/), {
      target: { value: 'DELETE' },
    })
    fireEvent.change(screen.getByLabelText(/現在のパスワード/), {
      target: { value: 'pw' },
    })
    fireEvent.click(screen.getByRole('button', { name: '削除を実行' }))

    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: '削除を実行' }),
      ).toBeNull()
    })
    expect(
      screen.getByText(/管理者があなた 1 人のため/),
    ).toBeTruthy()
    expect(
      screen.getByRole('link', { name: 'メンバー一覧へ移動' }),
    ).toBeTruthy()
  })

  it('成功時に signOut + window.location.href = / に遷移する', async () => {
    await mount('A', false)
    mocks.deleteMock.mockResolvedValue({ ok: true, case: 'family_deleted' })

    fireEvent.change(await screen.findByLabelText(/DELETE と入力/), {
      target: { value: 'DELETE' },
    })
    fireEvent.click(screen.getByRole('button', { name: '削除を実行' }))

    await waitFor(() => {
      expect(mocks.signOutMock).toHaveBeenCalled()
    })
    expect(window.location.href).toBe('/')
  })
})
