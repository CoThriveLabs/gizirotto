/**
 * useFormCache hook unit test
 *
 * 検証観点:
 *   - mount 時に snapshot 存在 + expectedPath 一致 → onRestore 1 回呼ばれる + snapshot 削除
 *   - mount 時に snapshot 存在 + expectedPath 不一致 → onRestore 呼ばれない + snapshot 保持
 *   - mount 時に snapshot なし → onRestore 呼ばれない
 *   - StrictMode 二重 mount で onRestore が 1 回のみ
 *   - saveSnapshot 後に sessionStorage に書き込まれる
 *   - clearSnapshot で sessionStorage から削除される
 *   - TTL 切れの snapshot は復元されない
 */
import React, { StrictMode } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { useFormCache } from '@/lib/hooks/use-form-cache'
import {
  FORM_CACHE_DEFAULT_TTL_MS,
  makeFormCacheKey,
  writeFormCache,
} from '@/lib/utils/form-cache'

type Values = { name: string; inputPath: 'A' | 'B' }

function TestHarness({
  formId,
  onRestore,
  onReady,
  ttlMs,
}: {
  formId: string
  onRestore?: (v: Values) => void
  onReady?: (api: {
    saveSnapshot: (v: Values) => void
    clearSnapshot: () => void
  }) => void
  ttlMs?: number
}) {
  const api = useFormCache<Values>(formId, { onRestore, ttlMs })
  React.useEffect(() => {
    onReady?.(api)
    // 1 度だけ ready 通知（テスト側の操作起点）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return <div data-testid="harness" />
}

beforeEach(() => {
  sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  sessionStorage.clear()
})

describe('useFormCache mount 時の復元動作', () => {
  it('snapshot あり + expectedPath 一致 → onRestore 1 回呼ばれて snapshot 削除', () => {
    const path = window.location.pathname
    writeFormCache<Values>(
      sessionStorage,
      'templates:new',
      { name: 'cached', inputPath: 'B' },
      path,
    )
    const onRestore = vi.fn()
    render(
      <TestHarness formId="templates:new" onRestore={onRestore} />,
    )
    expect(onRestore).toHaveBeenCalledTimes(1)
    expect(onRestore).toHaveBeenCalledWith({ name: 'cached', inputPath: 'B' })
    expect(sessionStorage.getItem(makeFormCacheKey('templates:new'))).toBeNull()
  })

  it('snapshot あり + expectedPath 不一致 → onRestore 呼ばれず snapshot 保持', () => {
    writeFormCache<Values>(
      sessionStorage,
      'templates:new',
      { name: 'cached', inputPath: 'A' },
      '/some/other/path',
    )
    const onRestore = vi.fn()
    render(
      <TestHarness formId="templates:new" onRestore={onRestore} />,
    )
    expect(onRestore).not.toHaveBeenCalled()
    expect(
      sessionStorage.getItem(makeFormCacheKey('templates:new')),
    ).not.toBeNull()
  })

  it('snapshot なし → onRestore 呼ばれない', () => {
    const onRestore = vi.fn()
    render(
      <TestHarness formId="templates:new" onRestore={onRestore} />,
    )
    expect(onRestore).not.toHaveBeenCalled()
  })

  it('StrictMode 二重 mount でも onRestore は 1 回のみ', () => {
    const path = window.location.pathname
    writeFormCache<Values>(
      sessionStorage,
      'templates:new',
      { name: 'strict', inputPath: 'A' },
      path,
    )
    const onRestore = vi.fn()
    render(
      <StrictMode>
        <TestHarness formId="templates:new" onRestore={onRestore} />
      </StrictMode>,
    )
    expect(onRestore).toHaveBeenCalledTimes(1)
  })

  it('TTL 切れの snapshot は復元されない', () => {
    const path = window.location.pathname
    const stale = Date.now() - FORM_CACHE_DEFAULT_TTL_MS - 1000
    // 古い savedAt を直接埋め込み
    sessionStorage.setItem(
      makeFormCacheKey('templates:new'),
      JSON.stringify({
        savedAt: stale,
        expectedPath: path,
        values: { name: 'stale', inputPath: 'A' },
      }),
    )
    const onRestore = vi.fn()
    render(
      <TestHarness formId="templates:new" onRestore={onRestore} />,
    )
    expect(onRestore).not.toHaveBeenCalled()
    // TTL 切れは read 時に自動 removeItem
    expect(sessionStorage.getItem(makeFormCacheKey('templates:new'))).toBeNull()
  })
})

describe('useFormCache saveSnapshot / clearSnapshot', () => {
  it('saveSnapshot で sessionStorage に書き込まれる', () => {
    let api:
      | {
          saveSnapshot: (v: Values) => void
          clearSnapshot: () => void
        }
      | null = null
    render(
      <TestHarness
        formId="templates:new"
        onReady={(a) => {
          api = a
        }}
      />,
    )
    expect(api).not.toBeNull()
    act(() => {
      api!.saveSnapshot({ name: 'saved', inputPath: 'B' })
    })
    const raw = sessionStorage.getItem(makeFormCacheKey('templates:new'))
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!) as {
      values: Values
      expectedPath: string
    }
    expect(parsed.values).toEqual({ name: 'saved', inputPath: 'B' })
    expect(parsed.expectedPath).toBe(window.location.pathname)
  })

  it('clearSnapshot で sessionStorage から削除される', () => {
    let api:
      | {
          saveSnapshot: (v: Values) => void
          clearSnapshot: () => void
        }
      | null = null
    render(
      <TestHarness
        formId="templates:new"
        onReady={(a) => {
          api = a
        }}
      />,
    )
    act(() => {
      api!.saveSnapshot({ name: 'saved', inputPath: 'A' })
    })
    expect(
      sessionStorage.getItem(makeFormCacheKey('templates:new')),
    ).not.toBeNull()
    act(() => {
      api!.clearSnapshot()
    })
    expect(sessionStorage.getItem(makeFormCacheKey('templates:new'))).toBeNull()
  })
})
