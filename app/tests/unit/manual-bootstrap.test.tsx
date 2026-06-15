/**
 * ManualBootstrap.tsx は /minutes/new/manual?template_id={id} 到達直後に
 * client mount + useEffect 起点で Server Action createMinute を一度だけ呼び、
 * 成功時 router.replace('/minutes/{id}/adjust') / 失敗時 toast.error + 戻り UI 表示
 * する責務を持つ。
 *
 * 検証項目:
 *   1. React StrictMode 下でも createMinute は 1 回しか呼ばれない（useRef ガード）
 *   2. createMinute 失敗時に「テンプレ選択に戻る」リンクが表示される
 */
import React, { StrictMode } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

const createMinuteMock = vi.fn()
const replaceMock = vi.fn()
const showToastMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: replaceMock,
    refresh: vi.fn(),
    back: vi.fn(),
  }),
}))

vi.mock('@/server/minutes', () => ({
  createMinute: (...args: unknown[]) => createMinuteMock(...args),
}))

vi.mock('@/components/toast/toast-context', () => ({
  useToast: () => ({
    showToast: showToastMock,
    dismissToast: vi.fn(),
    toasts: [],
  }),
}))

import { ManualBootstrap } from '@/app/(dashboard)/minutes/new/manual/ManualBootstrap'

describe('ManualBootstrap', () => {
  beforeEach(() => {
    createMinuteMock.mockReset()
    replaceMock.mockReset()
    showToastMock.mockReset()
  })

  it('StrictMode 二重 mount でも createMinute は 1 回しか呼ばれない', async () => {
    createMinuteMock.mockResolvedValue({ id: 'minute-uuid-xxx' })

    render(
      <StrictMode>
        <ManualBootstrap
          templateId="11111111-1111-1111-1111-111111111111"
          templateName="月次定例"
          fields={['議題', '決定事項']}
        />
      </StrictMode>,
    )

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/minutes/minute-uuid-xxx/adjust')
    })
    expect(createMinuteMock).toHaveBeenCalledTimes(1)
    const call = createMinuteMock.mock.calls[0][0]
    expect(call.templateId).toBe('11111111-1111-1111-1111-111111111111')
    expect(call.title).toBe('月次定例')
    expect(call.sourceMode).toBe('B-2')
    expect(call.content).toEqual({ 議題: '', 決定事項: '' })
    expect(call.meetingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('createMinute 失敗時は toast.error + 「テンプレ選択に戻る」リンクを表示する', async () => {
    createMinuteMock.mockRejectedValue(new Error('boom'))

    render(
      <ManualBootstrap
        templateId="22222222-2222-2222-2222-222222222222"
        templateName="週次"
        fields={[]}
      />,
    )

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(
        'error',
        '議事録の準備に失敗しました',
      )
    })
    const link = await screen.findByRole('link', { name: 'テンプレ選択に戻る' })
    expect(link.getAttribute('href')).toBe('/minutes/new')
    expect(replaceMock).not.toHaveBeenCalled()
  })
})
