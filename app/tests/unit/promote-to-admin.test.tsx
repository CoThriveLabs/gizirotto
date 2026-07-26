/**
 * PromoteToAdminButton / Modal UI ユニットテスト。
 *
 * 検証項目:
 *   1. 自分が admin かつ対象が member のときボタン表示
 *   2. 自分が admin だが対象が admin のときボタン非表示
 *   3. 自分が member のときボタン非表示 (どんな対象でも)
 *   4. クリックでモーダル表示 → 「昇格する」で promoteMemberToAdmin が呼ばれる
 *   5. 成功時に router.refresh + onClose
 *   6. ALREADY_ADMIN レスポンスでエラー表示
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  promoteMock: vi.fn(),
  refreshMock: vi.fn(),
}))

vi.mock('@/server/families', () => ({
  promoteMemberToAdmin: mocks.promoteMock,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: mocks.refreshMock,
    back: vi.fn(),
  }),
}))

import { PromoteToAdminButton } from '@/app/members/_components/PromoteToAdminButton'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('PromoteToAdminButton', () => {
  it('admin 自分 + member 対象でボタン表示', () => {
    render(
      <PromoteToAdminButton
        memberId="m-1"
        displayName="テスト太郎"
        currentRole="member"
        myRole="admin"
      />,
    )
    expect(screen.getByRole('button', { name: '管理者に昇格' })).toBeTruthy()
  })

  it('admin 自分 + admin 対象でボタン非表示', () => {
    render(
      <PromoteToAdminButton
        memberId="m-1"
        displayName="テスト太郎"
        currentRole="admin"
        myRole="admin"
      />,
    )
    expect(screen.queryByRole('button', { name: '管理者に昇格' })).toBeNull()
  })

  it('member 自分のとき (対象に関わらず) ボタン非表示', () => {
    render(
      <PromoteToAdminButton
        memberId="m-1"
        displayName="テスト太郎"
        currentRole="member"
        myRole="member"
      />,
    )
    expect(screen.queryByRole('button', { name: '管理者に昇格' })).toBeNull()
  })

  it('クリック → モーダル → 昇格する で promoteMemberToAdmin が呼ばれ refresh される', async () => {
    mocks.promoteMock.mockResolvedValue({ ok: true })
    render(
      <PromoteToAdminButton
        memberId="member-42"
        displayName="テスト太郎"
        currentRole="member"
        myRole="admin"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '管理者に昇格' }))

    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(screen.getByText(/「テスト太郎」さんを管理者に昇格/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '昇格する' }))

    await waitFor(() => {
      expect(mocks.promoteMock).toHaveBeenCalledWith('member-42')
    })
    await waitFor(() => {
      expect(mocks.refreshMock).toHaveBeenCalled()
    })
  })

  it('ALREADY_ADMIN レスポンスでエラー表示', async () => {
    mocks.promoteMock.mockResolvedValue({ ok: false, code: 'ALREADY_ADMIN' })
    render(
      <PromoteToAdminButton
        memberId="member-42"
        displayName="テスト太郎"
        currentRole="member"
        myRole="admin"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '管理者に昇格' }))
    fireEvent.click(await screen.findByRole('button', { name: '昇格する' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('既に管理者')
  })
})
