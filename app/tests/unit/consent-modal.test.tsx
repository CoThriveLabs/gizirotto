/**
 * ConsentModal — 同意成功後の遷移先分岐テスト。
 *
 * needsFamilySetup=true かつ pathname === '/' の場合のみ /family/setup へ replace する。
 * それ以外（pathname が '/' 以外、または needsFamilySetup=false）は refresh のみ。
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

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
  fireEvent.click(screen.getByLabelText('利用規約に同意'))
  fireEvent.click(screen.getByLabelText('プライバシーポリシーに同意'))
  fireEvent.click(screen.getByRole('button', { name: '同意して始める' }))
}

describe('ConsentModal', () => {
  it('needsFamilySetup=true かつ pathname="/" のとき、成功後に /family/setup へ replace してから refresh する', async () => {
    pathnameMock = '/'
    render(<ConsentModal needsFamilySetup={true} />)
    await agreeAndSubmit()

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/family/setup')
    })
    expect(refreshMock).toHaveBeenCalled()
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
