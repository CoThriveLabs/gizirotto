import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'

/**
 * MinuteCard の on-demand 自動 trigger ループ防止検証。
 *
 * 検証主眼:
 *   1. pending 状態でマウント → 1 回だけ fetch trigger（同マウント内再 fire しない）
 *   2. failed 状態でマウント → 自動 trigger 非発火（手動ボタンのみ）
 *   3. ready 状態でマウント → 自動 trigger 非発火
 */

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

const routerRefreshMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefreshMock }),
}))

import { MinuteCard } from '@/app/(home)/_components/MinuteCard'

const baseMinute = {
  id: 'min1',
  title: 'テスト議事録',
  meeting_date: '2026-06-10',
  thumbSignedUrl: null,
}

async function flush() {
  // Promise queue を進めるための microtask flush
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

describe('MinuteCard on-demand 自動 trigger（ループ防止）', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    routerRefreshMock.mockReset()
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('pending: マウント時に 1 回だけ POST する（triggeredRef で同マウント再 fire 防止）', async () => {
    const minute = { ...baseMinute, thumbStatus: 'pending' as const }
    const { rerender } = render(<MinuteCard minute={minute} eager={false} />)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/minutes/min1/regenerate-thumbnail',
    )
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' })

    // 同じマウント内で props 再評価が走っても再 fire しないこと
    rerender(<MinuteCard minute={minute} eager={false} />)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('failed: 自動 trigger 非発火（手動ボタンのみ）', async () => {
    const minute = { ...baseMinute, thumbStatus: 'failed' as const }
    render(<MinuteCard minute={minute} eager={false} />)
    await flush()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ready: 自動 trigger 非発火', async () => {
    const minute = {
      ...baseMinute,
      thumbStatus: 'ready' as const,
      thumbSignedUrl: 'https://example.com/sig',
    }
    render(<MinuteCard minute={minute} eager={false} />)
    await flush()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
