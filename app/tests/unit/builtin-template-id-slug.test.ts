import { describe, it, expect } from 'vitest'
import { resolveBuiltinBboxSlugFromTemplateId } from '@/lib/builtin-bbox-loader'
import { BUILTIN_TEMPLATE_IDS } from '@/lib/templates/builtin-ids'

/**
 * resolveBuiltinBboxSlugFromTemplateId — DB-free templateId → slug lookup used by
 * the guest-render route. Pins the mapping to the seed.sql builtin rows and keeps
 * it in sync with BUILTIN_TEMPLATE_IDS (every builtin ID must resolve to a slug).
 */
describe('resolveBuiltinBboxSlugFromTemplateId', () => {
  it('family-meeting ID は family-meeting slug を返す', () => {
    expect(
      resolveBuiltinBboxSlugFromTemplateId('00000000-0000-0000-0000-000000000001'),
    ).toBe('family-meeting')
  })

  it('child-schedule ID は child-schedule slug を返す', () => {
    expect(
      resolveBuiltinBboxSlugFromTemplateId('00000000-0000-0000-0000-000000000002'),
    ).toBe('child-schedule')
  })

  it('budget-report ID は budget-report slug を返す', () => {
    expect(
      resolveBuiltinBboxSlugFromTemplateId('00000000-0000-0000-0000-000000000003'),
    ).toBe('budget-report')
  })

  it('未知の UUID は null を返す', () => {
    expect(
      resolveBuiltinBboxSlugFromTemplateId('11111111-1111-1111-1111-111111111111'),
    ).toBeNull()
  })

  it('空文字は null を返す', () => {
    expect(resolveBuiltinBboxSlugFromTemplateId('')).toBeNull()
  })

  it('BUILTIN_TEMPLATE_IDS の全件が必ず非 null の slug に解決される（マップ同期保証）', () => {
    for (const id of BUILTIN_TEMPLATE_IDS) {
      expect(resolveBuiltinBboxSlugFromTemplateId(id), `id=${id}`).not.toBeNull()
    }
  })
})
