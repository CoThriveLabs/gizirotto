/**
 * §2-D7 (v2.5・D9 更新 2026-06-09): 詳細画面 MinutesViewer ZoomPanel の unit。
 *
 * 検証:
 *   - 初期 zoom=1 で img wrapper の width が "100%" になる（templates `bbox-pane.tsx` L551 同パターン）
 *   - ＋ボタン押下で zoom が ZOOM_STEP ぶん増え、wrapper width が拡大
 *   - −ボタン押下で zoom が ZOOM_STEP ぶん減り、wrapper width が縮小
 *   - range スライダーから zoom 値を直接設定可能
 *   - clampZoom により ZOOM_MIN..ZOOM_MAX の範囲外に出ない
 *   - D9: 親に overflow-auto wrapper が存在（横スクロールが機能する）
 *
 * fetch は mock（pages.length > 0 で ZoomPanel が出る経路を再現）。
 *
 * 🔴 D9 (ユーザー実機フィードバック 2026-06-09): transform: scale から img wrapper width スケールへ変更。
 *   transform は box サイズを変えず横 overflow を発生させないため、横スクロール不可だった。
 *   templates `bbox-pane.tsx` L551 同パターン `overflow-auto` + `flex justify-center min-w-min`
 *   を踏襲し、wrapper の width スケールで scroll-container を実拡大。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MinutesViewer } from '@/app/(dashboard)/minutes/[id]/_components/MinutesViewer'
import { ZOOM_MIN, ZOOM_MAX, ZOOM_STEP } from '@/lib/pdf-output/bbox-coords'

describe('MinutesViewer zoom (§2-D7 / D9)', () => {
  beforeEach(() => {
    // render-image API を mock: 即 signedUrl を返す。
    globalThis.fetch = vi.fn(async () =>
      Promise.resolve({
        ok: true,
        json: async () => ({ signedUrl: 'https://example.com/page1.png' }),
      } as unknown as Response),
    ) as unknown as typeof fetch
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function renderAndWaitForImage() {
    render(
      <MinutesViewer
        minuteId="m-1"
        title="テスト議事録"
        thumbnailStatus="ready"
      />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('minutes-viewer-img')).toBeTruthy()
    })
    return screen.getByTestId('minutes-viewer-img') as HTMLImageElement
  }

  /** img の祖先から「width スタイルを持つ wrapper」を取得（D9: img 親 div）。 */
  function getZoomWrapper(img: HTMLImageElement): HTMLElement {
    // <wrapper width=zoom*100%> > <img>
    const wrapper = img.parentElement
    if (!wrapper) throw new Error('zoom wrapper not found')
    return wrapper
  }

  it('初期 zoom=1: 親 wrapper の width が 100% になる', async () => {
    const img = await renderAndWaitForImage()
    const wrapper = getZoomWrapper(img)
    expect(wrapper.style.width).toBe('100%')
  })

  it('ZoomPanel が表示される（pages.length > 0 で出る）', async () => {
    await renderAndWaitForImage()
    expect(screen.getByLabelText('縮小')).toBeTruthy()
    expect(screen.getByLabelText('拡大')).toBeTruthy()
    expect(screen.getByLabelText('ズーム倍率')).toBeTruthy()
  })

  it('＋ボタンで zoom が増え wrapper width に反映される', async () => {
    const img = await renderAndWaitForImage()
    const plusBtn = screen.getByLabelText('拡大')
    await act(async () => {
      fireEvent.click(plusBtn)
    })
    const wrapper = getZoomWrapper(img)
    const pct = parseFloat(wrapper.style.width)
    expect(pct).toBeCloseTo((1 + ZOOM_STEP) * 100, 3)
  })

  it('−ボタンで zoom が減り wrapper width に反映される', async () => {
    const img = await renderAndWaitForImage()
    const minusBtn = screen.getByLabelText('縮小')
    await act(async () => {
      fireEvent.click(minusBtn)
    })
    const wrapper = getZoomWrapper(img)
    const pct = parseFloat(wrapper.style.width)
    expect(pct).toBeCloseTo((1 - ZOOM_STEP) * 100, 3)
  })

  it('range スライダーで zoom を直接変更できる', async () => {
    const img = await renderAndWaitForImage()
    const range = screen.getByLabelText('ズーム倍率') as HTMLInputElement
    await act(async () => {
      fireEvent.change(range, { target: { value: '2.0' } })
    })
    const wrapper = getZoomWrapper(img)
    expect(wrapper.style.width).toBe('200%')
  })

  it('clampZoom により ZOOM_MAX を超えない', async () => {
    const img = await renderAndWaitForImage()
    const range = screen.getByLabelText('ズーム倍率') as HTMLInputElement
    await act(async () => {
      // ZOOM_MAX を超える値を入れる
      fireEvent.change(range, { target: { value: String(ZOOM_MAX + 10) } })
    })
    const wrapper = getZoomWrapper(img)
    const pct = parseFloat(wrapper.style.width)
    expect(pct).toBeLessThanOrEqual(ZOOM_MAX * 100 + 0.001)
  })

  it('clampZoom により ZOOM_MIN を下回らない', async () => {
    const img = await renderAndWaitForImage()
    const range = screen.getByLabelText('ズーム倍率') as HTMLInputElement
    await act(async () => {
      fireEvent.change(range, { target: { value: String(ZOOM_MIN - 1) } })
    })
    const wrapper = getZoomWrapper(img)
    const pct = parseFloat(wrapper.style.width)
    expect(pct).toBeGreaterThanOrEqual(ZOOM_MIN * 100 - 0.001)
  })

  // D9: 横スクロール wrapper（overflow-auto）が img の祖先に存在する確認。
  // templates `bbox-pane.tsx` L551 同パターン。
  it('D9: 横スクロール wrapper (overflow-auto) が img 祖先に存在する', async () => {
    const img = await renderAndWaitForImage()
    let el: HTMLElement | null = img
    let found = false
    while (el) {
      const cls = el.className || ''
      if (typeof cls === 'string' && cls.includes('overflow-auto')) {
        found = true
        break
      }
      el = el.parentElement
    }
    expect(found).toBe(true)
  })
})
