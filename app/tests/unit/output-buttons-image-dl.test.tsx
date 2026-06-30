import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { OutputButtons } from '@/app/(dashboard)/minutes/[id]/_components/OutputButtons'

// ImagePreviewButton を stub
vi.mock('@/components/image-preview/image-preview-button', () => ({
  default: () => <button>画像で見る</button>,
}))

// next/link を stub
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

const clickMock = vi.fn()
let appendedAnchor: HTMLAnchorElement | null = null

beforeEach(() => {
  vi.clearAllMocks()
  appendedAnchor = null

  const originalCreateElement = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const el = originalCreateElement(tag)
    if (tag === 'a') {
      appendedAnchor = el as HTMLAnchorElement
      vi.spyOn(el, 'click').mockImplementation(clickMock)
    }
    return el
  })
})

describe('OutputButtons — 画像でダウンロード', () => {
  it('sourceFormat=pdf のとき「画像でダウンロード」ボタンが表示される', () => {
    render(
      <OutputButtons minuteId="min-1" title="テスト議事録" sourceFormat="pdf" />,
    )
    expect(screen.getByRole('button', { name: '画像でダウンロード' })).toBeInTheDocument()
  })

  it('sourceFormat=docx のとき「画像でダウンロード」ボタンは表示されない', () => {
    render(
      <OutputButtons minuteId="min-1" title="テスト議事録" sourceFormat="docx" />,
    )
    expect(
      screen.queryByRole('button', { name: '画像でダウンロード' }),
    ).not.toBeInTheDocument()
  })

  it('ボタンクリックで render-image に POST し signedUrl を anchor.click で開く', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        signedUrl: 'https://example.com/image.png',
        pages: 1,
      }),
    })

    render(
      <OutputButtons minuteId="min-42" title="議事録タイトル" sourceFormat="pdf" />,
    )

    const btn = screen.getByRole('button', { name: '画像でダウンロード' })
    await act(async () => {
      fireEvent.click(btn)
    })

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/minutes/min-42/render-image',
        expect.objectContaining({ method: 'POST' }),
      )
    })

    await waitFor(() => {
      expect(clickMock).toHaveBeenCalled()
    })

    // ファイル名規約: 単一ページ = {title}.png
    expect(appendedAnchor?.download).toBe('議事録タイトル.png')
  })

  it('複数ページ（pages > 1）のとき download ファイル名は {title}_画像.zip', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        signedUrl: 'https://example.com/image.zip',
        pages: 3,
      }),
    })

    render(
      <OutputButtons minuteId="min-99" title="複数ページ議事録" sourceFormat="pdf" />,
    )

    const btn = screen.getByRole('button', { name: '画像でダウンロード' })
    await act(async () => {
      fireEvent.click(btn)
    })

    await waitFor(() => {
      expect(clickMock).toHaveBeenCalled()
    })

    expect(appendedAnchor?.download).toBe('複数ページ議事録_画像.zip')
  })

  it('API エラー時はエラーメッセージが表示される', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: vi.fn().mockResolvedValue({ message: 'SERVER_ERROR' }),
    })

    render(
      <OutputButtons minuteId="min-err" title="エラーテスト" sourceFormat="pdf" />,
    )

    const btn = screen.getByRole('button', { name: '画像でダウンロード' })
    await act(async () => {
      fireEvent.click(btn)
    })

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })
  })
})
