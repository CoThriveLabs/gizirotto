import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import { GuestLocalStorageNoticeModal } from '@/components/usage/GuestLocalStorageNoticeModal'

afterEach(() => {
  cleanup()
})

describe('GuestLocalStorageNoticeModal', () => {
  it('open=true では見出しと本文が表示される', () => {
    render(<GuestLocalStorageNoticeModal open onClose={vi.fn()} />)
    expect(screen.getByText('下書きの保存についてのご案内')).toBeTruthy()
    expect(
      screen.getByText(
        'ログインせずに作成した下書きは、この端末のブラウザに一時的に保存されます。共有のパソコンをご利用の場合はご注意ください。',
      ),
    ).toBeTruthy()
  })

  it('open=false では null を返す（ダイアログが描画されない）', () => {
    render(<GuestLocalStorageNoticeModal open={false} onClose={vi.fn()} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('「はじめる」ボタン押下で onClose が呼ばれる', () => {
    const onClose = vi.fn()
    render(<GuestLocalStorageNoticeModal open onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'はじめる' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Esc キー押下で onClose が呼ばれる', () => {
    const onClose = vi.fn()
    render(<GuestLocalStorageNoticeModal open onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
