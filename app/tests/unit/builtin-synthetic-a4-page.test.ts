import { describe, it, expect } from 'vitest'
import { BUILTIN_SYNTHETIC_A4_PAGE } from '@/lib/pdf-output/bbox-coords'

/**
 * BUILTIN_SYNTHETIC_A4_PAGE は /api/templates/[id]/bbox-editor route 内の
 * ローカル定数 SYNTHETIC_A4_PAGE と同値であることをピン留めする。guest adjust 経路は
 * 認証必須の bbox-editor route を呼ばずこの定数を直接使うため、値が将来ズレた場合に
 * builtin の見た目（A4 595×842pt）が崩れる回帰をここで検知する。
 */
describe('BUILTIN_SYNTHETIC_A4_PAGE', () => {
  it('A4 縦（595×842pt・等倍 px）と一致する', () => {
    expect(BUILTIN_SYNTHETIC_A4_PAGE).toEqual({
      page: 1,
      widthPt: 595,
      heightPt: 842,
      pixelWidth: 595,
      pixelHeight: 842,
    })
  })
})
