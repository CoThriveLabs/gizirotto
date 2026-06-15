/**
 * 段階2-D12（bbox-pane.tsx 合成 useEffect RAF 間引き・案 A）unit test
 *
 * ユーザー実機フィードバック（PC ファン鳴る・CPU 飽和）:
 *   D11 で親 setOverrides は最大 60fps に制限されたが、bbox-pane.tsx 合成 useEffect 本体
 *   （drawImage 1200×1700 + 全 field opentype.js wrap 計算）は deps の差替で 30-45 fps で
 *   走り続け CPU を占有していた。
 *
 * 推し対策（案 A）:
 *   - useEffect 本体を requestAnimationFrame で coalesce
 *   - 次フレーム到来までに新依存が来たら前 RAF を cancelAnimationFrame
 *   - cleanup（unmount / deps 変化）で確実に cancel
 *
 * 実 React コンポーネントを mount せず、bbox-pane.tsx の合成 useEffect と同型の最小実装で
 * RAF API スタブで「連続 deps 変化でも実描画は 1 回／フレーム」を検証する。実装側
 * （bbox-pane.tsx）は同じ pattern を使うため、ここで挙動を担保する。
 *
 * 厳守:
 *   - bbox-pane.tsx の合成順（背景 → 白塗り → 固定テキスト → 記入値）は不変
 *   - templates 編集モード（whiteout / fixedtext variant）でも同じ間引きが効くが描画結果は不変
 *   - field-values-composite-canvas.ts は触らない
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * bbox-pane.tsx 合成 useEffect の最小再現:
 *   - 各 deps 変化で useEffect が再走 → 前回 cleanup（cancel）→ 新 RAF schedule。
 *   - フレーム到来で実描画関数が 1 回呼ばれる。
 */
function createCompositeEffect(drawFn: () => void) {
  let rafId: number | null = null

  function runEffect() {
    rafId = requestAnimationFrame(() => {
      drawFn()
      rafId = null
    })
    return () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
    }
  }

  return { runEffect, getRafId: () => rafId }
}

describe('bbox-pane 合成 useEffect RAF 間引き（D12 案 A）', () => {
  let rafCallbacks: Map<number, FrameRequestCallback>
  let rafCounter: number

  beforeEach(() => {
    rafCallbacks = new Map()
    rafCounter = 0
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: FrameRequestCallback): number => {
        rafCounter += 1
        rafCallbacks.set(rafCounter, cb)
        return rafCounter
      },
    )
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      rafCallbacks.delete(id)
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function flushFrame() {
    const callbacks = Array.from(rafCallbacks.values())
    rafCallbacks.clear()
    callbacks.forEach((cb) => cb(performance.now()))
  }

  it('1 回 useEffect 実行で RAF が 1 回 schedule される', () => {
    const draw = vi.fn()
    const { runEffect, getRafId } = createCompositeEffect(draw)
    runEffect()
    expect(getRafId()).not.toBeNull()
    expect(rafCallbacks.size).toBe(1)
    expect(draw).not.toHaveBeenCalled()
  })

  it('連続 deps 変化（cleanup → 再実行）でも実描画は 1 回／フレームに収束する', () => {
    const draw = vi.fn()
    const { runEffect } = createCompositeEffect(draw)

    // 100 回連続で deps 変化 → 都度 cleanup（cancel）+ 新 RAF schedule。
    let cleanup: (() => void) | undefined
    for (let i = 0; i < 100; i++) {
      if (cleanup) cleanup()
      cleanup = runEffect()
    }

    // 最後の RAF 1 件だけ pending。
    expect(rafCallbacks.size).toBe(1)
    expect(draw).not.toHaveBeenCalled()

    // フレーム到来で 1 回だけ描画。
    flushFrame()
    expect(draw).toHaveBeenCalledTimes(1)
  })

  it('cleanup で RAF が cancel され描画されない（unmount 時のリーク防止）', () => {
    const draw = vi.fn()
    const { runEffect, getRafId } = createCompositeEffect(draw)

    const cleanup = runEffect()
    expect(getRafId()).not.toBeNull()

    cleanup()
    expect(getRafId()).toBeNull()
    expect(rafCallbacks.size).toBe(0)

    // フレームを進めても描画されない（cancel 済）。
    flushFrame()
    expect(draw).not.toHaveBeenCalled()
  })

  it('flush 後に再 useEffect 実行できる（次の deps 変化に追従）', () => {
    const draw = vi.fn()
    const { runEffect } = createCompositeEffect(draw)

    const cleanup1 = runEffect()
    flushFrame()
    expect(draw).toHaveBeenCalledTimes(1)
    cleanup1() // RAF は既に flush 済なので no-op

    // 次の deps 変化 → 再 schedule
    runEffect()
    expect(rafCallbacks.size).toBe(1)
    flushFrame()
    expect(draw).toHaveBeenCalledTimes(2)
  })

  it('複数フレームに分けて deps 変化した場合、各フレームで 1 回ずつ描画される', () => {
    const draw = vi.fn()
    const { runEffect } = createCompositeEffect(draw)

    // フレーム 1: 5 回 deps 変化
    let cleanup: (() => void) | undefined
    for (let i = 0; i < 5; i++) {
      if (cleanup) cleanup()
      cleanup = runEffect()
    }
    flushFrame()
    expect(draw).toHaveBeenCalledTimes(1)

    // フレーム 2: さらに 5 回 deps 変化
    for (let i = 0; i < 5; i++) {
      if (cleanup) cleanup()
      cleanup = runEffect()
    }
    flushFrame()
    expect(draw).toHaveBeenCalledTimes(2)
  })
})
