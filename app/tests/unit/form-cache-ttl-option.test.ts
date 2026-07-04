/**
 * form-cache TTL option unit tests
 *
 * Verifies that:
 *   - custom ttlMs overrides the default 5-minute TTL
 *   - 30-minute TTL (guest flow) outlives the 5-minute default
 *   - snapshot written with 30-min TTL expires correctly at the 30-min boundary
 *   - default TTL applies when no ttlMs is given
 */
import { describe, it, expect } from 'vitest'
import {
  FORM_CACHE_DEFAULT_TTL_MS,
  clearFormCache,
  makeFormCacheKey,
  readFormCache,
  writeFormCache,
  type DraftStorage,
} from '@/lib/utils/form-cache'

function makeMemoryStorage(): DraftStorage & { _data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    _data: data,
    getItem(key) { return data.has(key) ? data.get(key)! : null },
    setItem(key, value) { data.set(key, value) },
    removeItem(key) { data.delete(key) },
  }
}

const GUEST_TTL_MS = 30 * 60 * 1000

describe('form-cache: TTL option', () => {
  it('デフォルト 5 分 TTL 内では読み取れる', () => {
    const s = makeMemoryStorage()
    const now = 1_000_000
    writeFormCache(s, 'test:formId', { v: 1 }, '/test', now)
    const entry = readFormCache(s, 'test:formId', FORM_CACHE_DEFAULT_TTL_MS, now + 1000)
    expect(entry).not.toBeNull()
    expect(entry!.values).toEqual({ v: 1 })
  })

  it('デフォルト 5 分 TTL を超過すると null', () => {
    const s = makeMemoryStorage()
    const now = 1_000_000
    writeFormCache(s, 'test:formId', { v: 1 }, '/test', now)
    const entry = readFormCache(
      s,
      'test:formId',
      FORM_CACHE_DEFAULT_TTL_MS,
      now + FORM_CACHE_DEFAULT_TTL_MS + 1,
    )
    expect(entry).toBeNull()
    // expired entry is removed
    expect(s._data.has(makeFormCacheKey('test:formId'))).toBe(false)
  })

  it('30 分 TTL を指定すると 5 分超過後も読み取れる', () => {
    const s = makeMemoryStorage()
    const now = 1_000_000
    writeFormCache(s, 'test:guest', { chat: 'hello' }, '/minutes/new/chat/tid', now)
    // 5 分 + 1 秒後でも 30 分 TTL なら有効
    const entry = readFormCache(
      s,
      'test:guest',
      GUEST_TTL_MS,
      now + FORM_CACHE_DEFAULT_TTL_MS + 1_000,
    )
    expect(entry).not.toBeNull()
    expect(entry!.values).toEqual({ chat: 'hello' })
  })

  it('30 分 TTL を超過すると null', () => {
    const s = makeMemoryStorage()
    const now = 1_000_000
    writeFormCache(s, 'test:guest', { chat: 'hello' }, '/minutes/new/chat/tid', now)
    const entry = readFormCache(
      s,
      'test:guest',
      GUEST_TTL_MS,
      now + GUEST_TTL_MS + 1,
    )
    expect(entry).toBeNull()
    expect(s._data.has(makeFormCacheKey('test:guest'))).toBe(false)
  })

  it('30 分 TTL のちょうど境界値は null ではない', () => {
    const s = makeMemoryStorage()
    const now = 1_000_000
    writeFormCache(s, 'test:guest', { x: 'y' }, '/path', now)
    const entry = readFormCache(s, 'test:guest', GUEST_TTL_MS, now + GUEST_TTL_MS)
    expect(entry).not.toBeNull()
  })

  it('minutes:new:chat:<id> formId のキーが form-cache:v1: プレフィックスを持つ', () => {
    const key = makeFormCacheKey('minutes:new:chat:00000000-0000-0000-0000-000000000001')
    expect(key).toBe('form-cache:v1:minutes:new:chat:00000000-0000-0000-0000-000000000001')
  })

  it('minutes:new:manual:<id> formId のキーが form-cache:v1: プレフィックスを持つ', () => {
    const key = makeFormCacheKey('minutes:new:manual:00000000-0000-0000-0000-000000000001')
    expect(key).toBe('form-cache:v1:minutes:new:manual:00000000-0000-0000-0000-000000000001')
  })

  it('新規 formId キーは既存 minutes:adjust-draft キーと衝突しない', () => {
    const chatKey = makeFormCacheKey('minutes:new:chat:00000000-0000-0000-0000-000000000001')
    const manualKey = makeFormCacheKey('minutes:new:manual:00000000-0000-0000-0000-000000000001')
    expect(chatKey).not.toBe('minutes:adjust-draft')
    expect(manualKey).not.toBe('minutes:adjust-draft')
  })

  it('clearFormCache で 30 分 TTL のエントリも削除できる', () => {
    const s = makeMemoryStorage()
    const now = 1_000_000
    writeFormCache(s, 'test:guest', { v: 1 }, '/path', now)
    expect(s._data.size).toBe(1)
    clearFormCache(s, 'test:guest')
    expect(s._data.size).toBe(0)
  })
})
