/**
 * ConsentModal — 同意成功後の遷移先分岐と、モーダル自身のクローズを検証する。
 *
 * needsFamilySetup=true かつ pathname === '/' の場合のみ /family/setup へ replace する。
 * replace した場合は refresh を呼ばない（refresh は現在のルート対象で replace と競合するため）。
 * それ以外（pathname が '/' 以外、または needsFamilySetup=false）は refresh のみ。
 *
 * 回帰ガード: モーダルを出す ConsentGate は root layout 直下の server component で、App Router は
 * 共有レイアウトをクライアント遷移で再描画しない。replace 経路でモーダルが残ると全画面
 * オーバーレイが遷移先に居座って操作不能になるため、送信成功後は必ず dialog が消えること。
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'

const replaceMock = vi.fn()
const refreshMock = vi.fn()
let pathnameMock = '/'

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: replaceMock,
    refresh: refreshMock,
    back: vi.fn(),
  }),
  usePathname: () => pathnameMock,
}))

import { ConsentModal } from '@/components/legal/ConsentModal'

beforeEach(() => {
  replaceMock.mockReset()
  refreshMock.mockReset()
  pathnameMock = '/'
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue({}),
  }) as unknown as typeof fetch
})

afterEach(() => {
  cleanup()
})

async function agreeAndSubmit() {
  await act(async () => {
    fireEvent.click(screen.getByLabelText('利用規約に同意'))
    fireEvent.click(screen.getByLabelText('プライバシーポリシーに同意'))
    fireEvent.click(screen.getByRole('button', { name: '同意して始める' }))
  })
}

describe('ConsentModal', () => {
  it('needsFamilySetup=true かつ pathname="/" のとき、/family/setup へ replace する', async () => {
    pathnameMock = '/'
    render(<ConsentModal needsFamilySetup={true} />)
    await agreeAndSubmit()

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/family/setup')
    })
    // モーダルは自前の state で閉じるので、この経路で refresh を呼ぶ必要はない
    // （refresh は現在のルート対象なので replace と競合する）。
    expect(refreshMock).not.toHaveBeenCalled()
  })

  it('replace 経路でも送信成功後に dialog が DOM から消え、body のスクロール抑制も解除される', async () => {
    pathnameMock = '/'
    render(<ConsentModal needsFamilySetup={true} />)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(document.body.style.overflow).toBe('hidden')

    await agreeAndSubmit()

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/family/setup')
    })
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    expect(document.body.style.overflow).not.toBe('hidden')
  })

  it('refresh 経路でも送信成功後に dialog が DOM から消える', async () => {
    pathnameMock = '/'
    render(<ConsentModal needsFamilySetup={false} />)
    await agreeAndSubmit()

    await waitFor(() => {
      expect(refreshMock).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
  })

  it('POST 失敗時はモーダルを閉じず、エラーを表示して再送信できる', async () => {
    pathnameMock = '/'
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: vi.fn().mockResolvedValue({ error: '記録に失敗' }),
    }) as unknown as typeof fetch
    render(<ConsentModal needsFamilySetup={true} />)
    await agreeAndSubmit()

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('記録に失敗')
    })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByRole('button', { name: '同意して始める' })).not.toBeDisabled()
    expect(replaceMock).not.toHaveBeenCalled()
    expect(refreshMock).not.toHaveBeenCalled()
  })

  it('needsFamilySetup=true でも pathname="/family/join" のときは replace せず refresh のみ', async () => {
    pathnameMock = '/family/join'
    render(<ConsentModal needsFamilySetup={true} />)
    await agreeAndSubmit()

    await waitFor(() => {
      expect(refreshMock).toHaveBeenCalled()
    })
    expect(replaceMock).not.toHaveBeenCalled()
  })

  it('needsFamilySetup=false のときは pathname="/" でも replace せず refresh のみ', async () => {
    pathnameMock = '/'
    render(<ConsentModal needsFamilySetup={false} />)
    await agreeAndSubmit()

    await waitFor(() => {
      expect(refreshMock).toHaveBeenCalled()
    })
    expect(replaceMock).not.toHaveBeenCalled()
  })
})
