/**
 * Header — isAuthenticated による「アカウントメニュー / ログインリンク」出し分けテスト。
 *
 * 回帰対象: 以前は displayName の有無だけで判定していたため、ログイン済みでも family 未参加
 * （display_name 未確定）だと「未ログイン」と誤表示された。isAuthenticated を唯一の判定材料にする。
 */
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('next/image', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: ({ priority: _priority, ...props }: any) => <img {...props} alt={props.alt} />,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
  }),
}))

import { Header } from '@/components/Header'

afterEach(() => {
  cleanup()
})

describe('Header', () => {
  it('isAuthenticated=false のとき「ログイン」リンクがあり、アカウントメニューボタンは無い', () => {
    render(<Header familyName="" displayName="" isAuthenticated={false} />)
    expect(screen.getByRole('link', { name: 'ログイン画面へ移動' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /アカウントメニューを開く/ })).toBeNull()
  })

  it('isAuthenticated=true, displayName="" のときアカウントメニューボタンがあり「ログイン」リンクは無い', () => {
    render(<Header familyName="" displayName="" isAuthenticated={true} />)
    expect(screen.getByRole('button', { name: 'アカウントメニューを開く' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'ログイン画面へ移動' })).toBeNull()
  })

  it('isAuthenticated=true, displayName 非空のときアカウントメニューボタンのラベルに名前が入る', () => {
    render(<Header familyName="山田家" displayName="お父さん" isAuthenticated={true} />)
    expect(
      screen.getByRole('button', { name: 'お父さん のアカウントメニューを開く' }),
    ).toBeTruthy()
  })
})
