/**
 * saveMinuteAdjust の revalidatePath 回帰防止 unit test。
 *
 * 背景:
 *   AdjustView 保存 → 詳細画面遷移 → AdjustView 戻り経路で、Router Cache に残った
 *   古い RSC が hydrate されて bbox が空表示になる。`revalidatePath('/minutes/[id]')`
 *   だけでは詳細画面しか invalidate されず、`/minutes/[id]/adjust` の RSC スナップショットは
 *   stale のまま。
 *
 * 修正本体:
 *   `saveMinuteAdjust` 末尾に `revalidatePath('/minutes/[id]/adjust')` を追加。
 *   `saveBboxOverrides` / `updateMinute` も同じ理由で adjust path 追加。
 *
 * 本テストの目的:
 *   saveMinuteAdjust の成功経路で `/minutes/[id]/adjust` が revalidatePath されることを
 *   spy で確認する（save-minute-adjust-not-persisted.test.ts とは別ファイル・成功経路担保）。
 *
 * モック方針:
 *   - save-minute-adjust-not-persisted.test.ts の Supabase chain 構造を拡張し、
 *     update().select().maybeSingle() を {data:{id},error:null} 返却にして成功経路を通す。
 *   - regenerate / service client は副作用無効化。
 *   - revalidatePath は vi.fn() で spy。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const TEST_MINUTE_ID = '00000000-0000-0000-0000-000000000311'

const getUserMock = vi.fn(async () => ({ data: { user: { id: 'u-1' } } }))

function buildSuccessUpdateChain() {
  return {
    update: vi.fn(() => ({
      eq: vi.fn(() => ({
        select: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({
            data: { id: TEST_MINUTE_ID },
            error: null,
          })),
        })),
      })),
    })),
  }
}

const fromImpl = vi.fn((table: string) => {
  if (table !== 'minutes') {
    throw new Error(`unexpected table: ${table}`)
  }
  return buildSuccessUpdateChain()
})

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: { getUser: getUserMock },
    from: fromImpl,
  })),
}))

vi.mock('@/lib/supabase/service', () => ({
  createSupabaseServiceClient: vi.fn(() => ({
    from: vi.fn(),
    storage: { from: vi.fn() },
  })),
}))

vi.mock('@/lib/pdf-output/regenerate-minute-pdf', () => ({
  regenerateMinutePdf: vi.fn(async () => ({ ok: true, outputPath: 'x' })),
}))

const { revalidatePathMock } = vi.hoisted(() => ({
  revalidatePathMock: vi.fn(),
}))
vi.mock('next/cache', () => ({
  revalidatePath: revalidatePathMock,
}))

import { saveMinuteAdjust } from '@/server/minutes'

describe('saveMinuteAdjust が adjust path も revalidate する', () => {
  beforeEach(() => {
    getUserMock.mockClear()
    fromImpl.mockClear()
    revalidatePathMock.mockClear()
  })

  it('成功経路で /minutes/[id] と /minutes/[id]/adjust の両方を revalidatePath する', async () => {
    const result = await saveMinuteAdjust({
      id: TEST_MINUTE_ID,
      content: { attendees: '', agenda: '', todos: 'p' },
      overrides: {},
    })
    expect(result).toEqual({ ok: true })

    const calls = revalidatePathMock.mock.calls.map((c) => c[0])
    expect(calls).toContain(`/minutes/${TEST_MINUTE_ID}`)
    expect(calls).toContain(`/minutes/${TEST_MINUTE_ID}/adjust`)
  })

  it('adjust path 用 revalidatePath は詳細画面用の後段で呼ばれる（順序固定）', async () => {
    await saveMinuteAdjust({
      id: TEST_MINUTE_ID,
      content: { todos: 'p' },
      overrides: {},
    })
    const calls = revalidatePathMock.mock.calls.map((c) => c[0])
    const detailIdx = calls.indexOf(`/minutes/${TEST_MINUTE_ID}`)
    const adjustIdx = calls.indexOf(`/minutes/${TEST_MINUTE_ID}/adjust`)
    expect(detailIdx).toBeGreaterThanOrEqual(0)
    expect(adjustIdx).toBeGreaterThanOrEqual(0)
    // 「詳細画面 → adjust 画面」の順で revalidate（コードの意図順序固定）。
    expect(adjustIdx).toBeGreaterThan(detailIdx)
  })
})
