import { describe, it, expect } from 'vitest'
import { BUILTIN_TEMPLATE_IDS, isBuiltinTemplate } from '@/lib/templates/builtin-ids'

describe('BUILTIN_TEMPLATE_IDS', () => {
  it('セットに 3 件の builtin ID が含まれる', () => {
    expect(BUILTIN_TEMPLATE_IDS.size).toBe(3)
  })

  it('family-meeting ID が含まれる', () => {
    expect(BUILTIN_TEMPLATE_IDS.has('00000000-0000-0000-0000-000000000001')).toBe(true)
  })

  it('child-schedule ID が含まれる', () => {
    expect(BUILTIN_TEMPLATE_IDS.has('00000000-0000-0000-0000-000000000002')).toBe(true)
  })

  it('budget-report ID が含まれる', () => {
    expect(BUILTIN_TEMPLATE_IDS.has('00000000-0000-0000-0000-000000000003')).toBe(true)
  })
})

describe('isBuiltinTemplate', () => {
  it.each([
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000003',
  ])('builtin ID %s は true を返す', (id) => {
    expect(isBuiltinTemplate(id)).toBe(true)
  })

  it('ランダムな uuid は false を返す', () => {
    expect(isBuiltinTemplate('12345678-1234-1234-1234-123456789012')).toBe(false)
  })

  it('空文字は false を返す', () => {
    expect(isBuiltinTemplate('')).toBe(false)
  })

  it('大文字英字を含む UUID は false を返す（ID は小文字固定）', () => {
    // 0 のみで構成される builtin ID は大文字化しても変わらないため、
    // 英字 a-f を含む UUID で大文字変換の排除を検証する。
    expect(isBuiltinTemplate('A0000000-0000-0000-0000-000000000001')).toBe(false)
  })

  it('builtin ID の末尾 1 桁が違う ID は false を返す', () => {
    expect(isBuiltinTemplate('00000000-0000-0000-0000-000000000004')).toBe(false)
  })

  it('builtin ID の先頭部分だけ一致する文字列は false を返す', () => {
    expect(isBuiltinTemplate('00000000-0000-0000-0000-00000000000')).toBe(false)
  })
})
