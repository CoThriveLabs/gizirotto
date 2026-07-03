/**
 * updateMinute の excludeFromLearning 反映テスト。
 *
 * 議事録詳細の「この議事録を書き方の学習に使わない」トグルは updateMinute 経由で
 * exclude_from_learning を patch する。content 未指定時は output_*_path をリセットしない
 * 既存挙動（回帰）も併せて確認する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const getUserMock = vi.fn(async () => ({ data: { user: { id: 'u-1' } } }))
const updateMock = vi.fn()

function buildUpdateChain() {
  return {
    update: updateMock.mockImplementation(() => ({
      eq: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn(async () => ({ data: { id: 'minute-1' }, error: null })),
        })),
      })),
    })),
  }
}

const fromImpl = vi.fn((table: string) => {
  if (table !== 'minutes') {
    throw new Error(`unexpected table: ${table}`)
  }
  return buildUpdateChain()
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

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

import { updateMinute } from '@/server/minutes'

const MINUTE_ID = '00000000-0000-0000-0000-000000000001'

describe('updateMinute excludeFromLearning', () => {
  beforeEach(() => {
    getUserMock.mockClear()
    updateMock.mockClear()
    fromImpl.mockClear()
  })

  it('excludeFromLearning:true を渡すと patch に exclude_from_learning:true が乗る', async () => {
    await updateMinute({ id: MINUTE_ID, excludeFromLearning: true })
    expect(updateMock).toHaveBeenCalledTimes(1)
    const patch = updateMock.mock.calls[0][0]
    expect(patch.exclude_from_learning).toBe(true)
  })

  it('excludeFromLearning:false も明示的に patch へ反映される', async () => {
    await updateMinute({ id: MINUTE_ID, excludeFromLearning: false })
    const patch = updateMock.mock.calls[0][0]
    expect(patch.exclude_from_learning).toBe(false)
  })

  it('excludeFromLearning 省略時は patch に含まれない（回帰）', async () => {
    await updateMinute({ id: MINUTE_ID, title: '新タイトル' })
    const patch = updateMock.mock.calls[0][0]
    expect(patch.exclude_from_learning).toBeUndefined()
    expect(patch.output_pdf_path).toBeUndefined()
  })
})
