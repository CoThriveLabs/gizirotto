/**
 * useFormCache hook tests — TTL option and guest 30-min flow
 *
 * Verifies that:
 *   - ttlMs option is forwarded to readFormCache (30-min snapshot survives 5-min default boundary)
 *   - snapshot written with 30-min TTL is NOT restored after 30 minutes (TTL expired)
 *   - minutes:new:chat / minutes:new:manual formId patterns restore correctly on mount
 */
import React, { StrictMode } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { useFormCache } from '@/lib/hooks/use-form-cache'
import { FORM_CACHE_DEFAULT_TTL_MS, makeFormCacheKey } from '@/lib/utils/form-cache'

const GUEST_TTL_MS = 30 * 60 * 1000

type ChatSnapshot = { messages: Array<{ role: string; content: string }>; input: string }
type ManualSnapshot = Record<string, string>

function ChatHarness({
  templateId,
  onRestore,
}: {
  templateId: string
  onRestore: (v: ChatSnapshot) => void
}) {
  useFormCache<ChatSnapshot>(`minutes:new:chat:${templateId}`, {
    ttlMs: GUEST_TTL_MS,
    onRestore,
  })
  return <div />
}

function ManualHarness({
  templateId,
  onRestore,
}: {
  templateId: string
  onRestore: (v: ManualSnapshot) => void
}) {
  useFormCache<ManualSnapshot>(`minutes:new:manual:${templateId}`, {
    ttlMs: GUEST_TTL_MS,
    onRestore,
  })
  return <div />
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('useFormCache — 30 min TTL option (guest flow)', () => {
  const tid = '00000000-0000-0000-0000-000000000001'

  it('5 分超過後でも 30 分 TTL なら onRestore が呼ばれる', () => {
    const path = window.location.pathname
    // Manually write a snapshot older than 5 min but within 30 min
    const savedAt = Date.now() - FORM_CACHE_DEFAULT_TTL_MS - 30_000 // 5 min + 30 sec ago
    const entry = {
      savedAt,
      expectedPath: path,
      values: { messages: [{ role: 'assistant', content: 'こんにちは' }], input: 'テスト' },
    }
    localStorage.setItem(
      makeFormCacheKey(`minutes:new:chat:${tid}`),
      JSON.stringify(entry),
    )

    const onRestore = vi.fn()
    render(<ChatHarness templateId={tid} onRestore={onRestore} />)
    expect(onRestore).toHaveBeenCalledTimes(1)
    expect(onRestore).toHaveBeenCalledWith(entry.values)
    // snapshot is cleared after restore
    expect(localStorage.getItem(makeFormCacheKey(`minutes:new:chat:${tid}`))).toBeNull()
  })

  it('30 分超過後は onRestore が呼ばれない', () => {
    const path = window.location.pathname
    const savedAt = Date.now() - GUEST_TTL_MS - 1_000 // 30 min + 1 sec ago
    localStorage.setItem(
      makeFormCacheKey(`minutes:new:chat:${tid}`),
      JSON.stringify({
        savedAt,
        expectedPath: path,
        values: { messages: [], input: 'stale' },
      }),
    )

    const onRestore = vi.fn()
    render(<ChatHarness templateId={tid} onRestore={onRestore} />)
    expect(onRestore).not.toHaveBeenCalled()
    // expired entry is auto-removed
    expect(localStorage.getItem(makeFormCacheKey(`minutes:new:chat:${tid}`))).toBeNull()
  })

  it('minutes:new:manual の snapshot が onRestore で復元される', () => {
    const path = window.location.pathname
    const values: ManualSnapshot = { 議題: 'テスト議題', 決定事項: 'テスト決定' }
    const savedAt = Date.now() - 60_000 // 1 min ago (within 30 min)
    localStorage.setItem(
      makeFormCacheKey(`minutes:new:manual:${tid}`),
      JSON.stringify({ savedAt, expectedPath: path, values }),
    )

    const onRestore = vi.fn()
    render(<ManualHarness templateId={tid} onRestore={onRestore} />)
    expect(onRestore).toHaveBeenCalledTimes(1)
    expect(onRestore).toHaveBeenCalledWith(values)
  })

  it('StrictMode 二重 mount でも onRestore は 1 回のみ', () => {
    const path = window.location.pathname
    localStorage.setItem(
      makeFormCacheKey(`minutes:new:chat:${tid}`),
      JSON.stringify({
        savedAt: Date.now(),
        expectedPath: path,
        values: { messages: [], input: 'strict' },
      }),
    )

    const onRestore = vi.fn()
    render(
      <StrictMode>
        <ChatHarness templateId={tid} onRestore={onRestore} />
      </StrictMode>,
    )
    expect(onRestore).toHaveBeenCalledTimes(1)
  })

  it('expectedPath 不一致では復元されない', () => {
    localStorage.setItem(
      makeFormCacheKey(`minutes:new:chat:${tid}`),
      JSON.stringify({
        savedAt: Date.now(),
        expectedPath: '/some/other/path',
        values: { messages: [], input: 'wrong path' },
      }),
    )

    const onRestore = vi.fn()
    render(<ChatHarness templateId={tid} onRestore={onRestore} />)
    expect(onRestore).not.toHaveBeenCalled()
    // snapshot NOT removed (may be restored when user navigates back to correct path)
    expect(
      localStorage.getItem(makeFormCacheKey(`minutes:new:chat:${tid}`)),
    ).not.toBeNull()
  })
})
