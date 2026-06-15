/**
 * 段階2-D3 案 D（v2.5 §1-2-6-2）: useDebouncedSelectedBackground フックの unit。
 *
 * 検証:
 *   - selected=null: fetch 呼ばれない・bgUrl=null
 *   - selected 設定 + 300ms 経過: fetch が `raw_except_selected` 付きで呼ばれる
 *   - 連打: 連続切替で fetch は最後の 1 回だけ走る（debounce 効いている）
 *   - 失敗（!res.ok）: bgUrl=null 維持・例外を投げない
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDebouncedSelectedBackground } from '@/lib/utils/use-debounced-selected-background'

function makeFetchMock(signedUrl = 'https://example.com/signed.png') {
  return vi.fn(async (_url: string, _init?: RequestInit) =>
    Promise.resolve({
      ok: true,
      json: async () => ({ signedUrl }),
    } as unknown as Response),
  )
}

describe('useDebouncedSelectedBackground', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('selected=null では fetch を呼ばず、bgUrl=null を返す', () => {
    const fetchMock = makeFetchMock()
    const { result } = renderHook(() =>
      useDebouncedSelectedBackground({
        minuteId: 'm-1',
        selected: null,
        debounceMs: 300,
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    )
    expect(result.current).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('selected 指定 + 300ms 経過で fetch が raw_except_selected 付きで呼ばれる', async () => {
    const fetchMock = makeFetchMock('https://example.com/memo.png')
    const { result, rerender } = renderHook(
      ({ selected }: { selected: string | null }) =>
        useDebouncedSelectedBackground({
          minuteId: 'm-1',
          selected,
          debounceMs: 300,
          fetchImpl: fetchMock as unknown as typeof fetch,
        }),
      { initialProps: { selected: null as string | null } },
    )

    // selected を 'memo' に変える
    rerender({ selected: 'memo' })
    // まだ fetch は呼ばれない（300ms 未満）
    expect(fetchMock).not.toHaveBeenCalled()

    // 300ms 進める → setTimeout コールバックが発火 → fetch 呼出
    await act(async () => {
      vi.advanceTimersByTime(300)
      // microtask flush
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/minutes/m-1/render-image')
    expect(opts.method).toBe('POST')
    const body = JSON.parse(String(opts.body))
    expect(body.raw).toBe(true)
    expect(body.raw_except_selected).toBe('memo')
    expect(body.dpi).toBe(150)
    expect(body.format).toBe('png')

    // bgUrl が反映されている
    expect(result.current).toBe('https://example.com/memo.png')
  })

  it('連打: 300ms 内に複数回 selected 切替えても fetch は最後の 1 回だけ走る', async () => {
    const fetchMock = makeFetchMock('https://example.com/x.png')
    const { rerender } = renderHook(
      ({ selected }: { selected: string | null }) =>
        useDebouncedSelectedBackground({
          minuteId: 'm-1',
          selected,
          debounceMs: 300,
          fetchImpl: fetchMock as unknown as typeof fetch,
        }),
      { initialProps: { selected: null as string | null } },
    )

    rerender({ selected: 'a' })
    vi.advanceTimersByTime(100)
    rerender({ selected: 'b' })
    vi.advanceTimersByTime(100)
    rerender({ selected: 'c' })

    // ここまでで 200ms 経過 → 'a' の timer も 'b' の timer も cleanup されている
    expect(fetchMock).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(300)
      await Promise.resolve()
      await Promise.resolve()
    })

    // 最後の 'c' に対する fetch のみ走る
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))
    expect(body.raw_except_selected).toBe('c')
  })

  it('!res.ok: bgUrl を更新しない（既存 rawBgUrl 経路にフォールバック）', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Promise.resolve({ ok: false, json: async () => ({}) } as unknown as Response),
    )
    const { result, rerender } = renderHook(
      ({ selected }: { selected: string | null }) =>
        useDebouncedSelectedBackground({
          minuteId: 'm-1',
          selected,
          debounceMs: 300,
          fetchImpl: fetchMock as unknown as typeof fetch,
        }),
      { initialProps: { selected: null as string | null } },
    )

    rerender({ selected: 'x' })
    await act(async () => {
      vi.advanceTimersByTime(300)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.current).toBeNull()
  })

  it('selected を null に戻すと bgUrl が null にリセットされる', async () => {
    const fetchMock = makeFetchMock('https://example.com/foo.png')
    const { result, rerender } = renderHook(
      ({ selected }: { selected: string | null }) =>
        useDebouncedSelectedBackground({
          minuteId: 'm-1',
          selected,
          debounceMs: 300,
          fetchImpl: fetchMock as unknown as typeof fetch,
        }),
      { initialProps: { selected: null as string | null } },
    )

    rerender({ selected: 'foo' })
    await act(async () => {
      vi.advanceTimersByTime(300)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current).toBe('https://example.com/foo.png')

    // null に戻す
    rerender({ selected: null })
    expect(result.current).toBeNull()
  })
})
