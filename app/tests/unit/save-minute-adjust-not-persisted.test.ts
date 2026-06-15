/**
 * saveMinuteAdjust 無音 0 件 UPDATE 検知テスト。
 *
 * 検証スコープ:
 *   `saveMinuteAdjust` の `.update().select().maybeSingle()` 経路で「対象 0 件」が返った
 *   場合に明示的に throw されることを保証する（旧実装は無音 success だった）。
 *
 * 背景:
 *   PostgREST の `.update().eq(id)` は RLS が UPDATE を全件除外したケースでも
 *   error=null のまま 0 件成功扱いを返す。これにより client は「保存成功」と判定し
 *   router.push → reload 時に DB 値は更新されていない（「入力値が全消え」現象）。
 *
 *   本テストは Supabase client を最小モックして、update 後の select().maybeSingle() が
 *   `{ data: null, error: null }` を返す状況を再現し、関数が `MINUTE_UPDATE_NOT_PERSISTED`
 *   を投げることを assert する。
 *
 * モック方針:
 *   - `@/lib/supabase/server` の `createSupabaseServerClient` を mock し、auth.getUser は
 *     正常ユーザを返す。.from('minutes').update().eq().select().maybeSingle() は data=null。
 *   - `@/lib/supabase/service` も最小 mock（regenerate は呼ばれずに throw で抜けるが防御で）。
 *   - regenerate 系・revalidatePath は副作用無効化。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const getUserMock = vi.fn(async () => ({ data: { user: { id: 'u-1' } } }))

function buildUpdateChain(returnRow: unknown) {
  // .update(patch).eq(field, val).select('id').maybeSingle() の chain を再現。
  return {
    update: vi.fn(() => ({
      eq: vi.fn(() => ({
        select: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({ data: returnRow, error: null })),
        })),
      })),
    })),
  }
}

const fromImpl = vi.fn((table: string) => {
  if (table !== 'minutes') {
    throw new Error(`unexpected table: ${table}`)
  }
  return buildUpdateChain(null)
})

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: { getUser: getUserMock },
    from: fromImpl,
  })),
}))

// service client（regenerate 経路）は本テストで呼ばれない（throw で抜けるため）が、
// import 時のエラーを避けるため最小 stub。
vi.mock('@/lib/supabase/service', () => ({
  createSupabaseServiceClient: vi.fn(() => ({
    from: vi.fn(),
    storage: { from: vi.fn() },
  })),
}))

// regenerate 純関数は呼ばれないが import チェーン分の stub。
vi.mock('@/lib/pdf-output/regenerate-minute-pdf', () => ({
  regenerateMinutePdf: vi.fn(async () => ({ ok: true, outputPath: 'x' })),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

import { saveMinuteAdjust } from '@/server/minutes'

describe('saveMinuteAdjust 無音 0 件 UPDATE 検知', () => {
  beforeEach(() => {
    getUserMock.mockClear()
    fromImpl.mockClear()
  })

  it('update().select().maybeSingle() が data=null を返したとき MINUTE_UPDATE_NOT_PERSISTED を throw する', async () => {
    await expect(
      saveMinuteAdjust({
        id: '00000000-0000-0000-0000-000000000001',
        content: { attendees: 'pppppp', agenda: 'p' },
        overrides: {},
      }),
    ).rejects.toThrow('MINUTE_UPDATE_NOT_PERSISTED')

    // .from('minutes') が呼ばれている = update 経路まで到達した証拠。
    expect(fromImpl).toHaveBeenCalledWith('minutes')
  })
})
