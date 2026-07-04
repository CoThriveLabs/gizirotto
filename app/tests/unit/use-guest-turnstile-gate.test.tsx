/**
 * useGuestTurnstileGate — Turnstile トークン到着待ちの中央ゲート。
 *
 * chat 経路の初回 kick-off 競合状態バグ（widget mount 前に fetch が走り 403）を吸収する
 * のが主目的。format-item 経路の欠落バグも同じ hook で解決する。
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useGuestTurnstileGate } from '@/hooks/useGuestTurnstileGate'

describe('useGuestTurnstileGate', () => {
  it('(a) enabled=false: consumeToken() は即 undefined を返す（ログインユーザー経路）', async () => {
    const { result } = renderHook(() => useGuestTurnstileGate(false))
    const token = await result.current.consumeToken()
    expect(token).toBeUndefined()
  })

  it('(b) enabled=true・token 既到着: 即 token を返し内部 state をクリア', async () => {
    const { result, rerender } = renderHook(() => useGuestTurnstileGate(true))

    // onToken 到着 → state に格納
    act(() => {
      result.current.onToken('token-1')
    })
    rerender()

    // 1 回目: 到着済み token を即 resolve
    const first = await result.current.consumeToken()
    expect(first).toBe('token-1')

    // 2 回目: state はクリア済み → 到着未 → 待機（await のフリーズは避けるため resolve を仕込む）
    rerender()
    const p = result.current.consumeToken()
    act(() => {
      result.current.onToken('token-2')
    })
    expect(await p).toBe('token-2')
  })

  it('(c) enabled=true・token 未到着 → 到着: waiter が待機、onToken で resolve される', async () => {
    const { result } = renderHook(() => useGuestTurnstileGate(true))

    // 到着前に consumeToken() → Promise 保留
    const p = result.current.consumeToken()

    // 別 tick で onToken 発火
    act(() => {
      result.current.onToken('kick-token')
    })
    expect(await p).toBe('kick-token')
  })

  it('(d) 連続 consume: 1 回目 waiter resolve 後、2 回目は新たな waiter として待機する', async () => {
    const { result, rerender } = renderHook(() => useGuestTurnstileGate(true))

    const p1 = result.current.consumeToken()
    act(() => result.current.onToken('t1'))
    expect(await p1).toBe('t1')

    rerender()
    const p2 = result.current.consumeToken()
    act(() => result.current.onToken('t2'))
    expect(await p2).toBe('t2')
  })

  it('(e) 空文字 onToken（onError/onExpire 相当）でも待機が解除される（ハング防止）', async () => {
    const { result } = renderHook(() => useGuestTurnstileGate(true))

    const p = result.current.consumeToken()
    act(() => {
      result.current.onToken('')
    })
    // 空文字で resolve される（サーバ側で TURNSTILE_FAILED → 通常のエラーフローへ）。
    expect(await p).toBe('')
  })

  it('reset(): bind された widget の reset を呼ぶ', () => {
    const { result } = renderHook(() => useGuestTurnstileGate(true))
    const resetSpy = vi.fn()

    act(() => {
      result.current.bindWidget({ reset: resetSpy })
    })
    act(() => {
      result.current.reset()
    })
    expect(resetSpy).toHaveBeenCalledTimes(1)
  })

  it('reset(): widget 未 bind でも no-op（例外を投げない）', () => {
    const { result } = renderHook(() => useGuestTurnstileGate(true))
    // widget を bind せずに reset() → 例外にならないこと
    expect(() => {
      act(() => {
        result.current.reset()
      })
    }).not.toThrow()
  })

  it('reset(): bindWidget(null) で切断後は no-op', () => {
    const { result } = renderHook(() => useGuestTurnstileGate(true))
    const resetSpy = vi.fn()

    act(() => {
      result.current.bindWidget({ reset: resetSpy })
    })
    act(() => {
      result.current.bindWidget(null)
    })
    act(() => {
      result.current.reset()
    })
    expect(resetSpy).not.toHaveBeenCalled()
  })
})
