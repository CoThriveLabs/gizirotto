import { describe, it, expect } from 'vitest'
import {
  bboxBoxClass,
  bboxHandleClass,
  bboxLabelClass,
} from '@/app/(dashboard)/templates/[id]/bbox-variant'

// BboxPane の見た目 variant 出し分けの担保。
// 最重要受入条件＝'field'（記入欄）の青枠は無改変保証。
// 'whiteout'（白塗り）は灰色系で記入欄(青)と視覚差別化される。
describe('bboxBoxClass / handle / label（variant 出し分け）', () => {
  describe("variant='field'（記入欄・段階1完了時と同一であること）", () => {
    it('選択中: 青濃枠（border-gizirotto-blue-700 bg-gizirotto-blue-500/20）', () => {
      expect(bboxBoxClass('field', true)).toBe(
        'border-gizirotto-blue-700 bg-gizirotto-blue-500/20',
      )
    })
    it('非選択: 青枠＋hover（border-gizirotto-blue-500 bg-gizirotto-blue-500/10 hover:bg-gizirotto-blue-500/20）', () => {
      expect(bboxBoxClass('field', false)).toBe(
        'border-gizirotto-blue-500 bg-gizirotto-blue-500/10 hover:bg-gizirotto-blue-500/20',
      )
    })
    it('ハンドル: 青枠ハンドル', () => {
      expect(bboxHandleClass('field')).toBe(
        'bg-white border-2 border-gizirotto-blue-700 rounded-sm',
      )
    })
    it('label バッジ: 青', () => {
      expect(bboxLabelClass('field')).toBe('bg-gizirotto-blue-700 text-white')
    })
  })

  describe("variant='whiteout'（白塗り・灰色系で青と差別化）", () => {
    it('選択中: 灰色枠＋ring（青ではない・ring で強調）', () => {
      const cls = bboxBoxClass('whiteout', true)
      expect(cls).toContain('border-gray-600')
      expect(cls).toContain('ring-2')
      // 記入欄(青)と差別化: ame-blue の枠/塗りは付かない。
      expect(cls).not.toContain('border-ame-blue')
      expect(cls).not.toContain('bg-ame-blue')
    })
    it('非選択: 灰色枠（青ではない）', () => {
      const cls = bboxBoxClass('whiteout', false)
      expect(cls).toContain('border-gray-500')
      expect(cls).toContain('bg-gray-400/30')
      expect(cls).not.toContain('border-ame-blue')
      expect(cls).not.toContain('bg-ame-blue')
    })
    it('ハンドル/label も灰色系（青ではない）', () => {
      expect(bboxHandleClass('whiteout')).toContain('border-gray-600')
      expect(bboxHandleClass('whiteout')).not.toContain('ame-blue')
      expect(bboxLabelClass('whiteout')).toContain('bg-gray-700')
      expect(bboxLabelClass('whiteout')).not.toContain('ame-blue')
    })
  })

  it('field と whiteout は選択/非選択とも別 className（一目で別物）', () => {
    expect(bboxBoxClass('field', true)).not.toBe(bboxBoxClass('whiteout', true))
    expect(bboxBoxClass('field', false)).not.toBe(
      bboxBoxClass('whiteout', false),
    )
  })

  // 白塗り auto=破線 / manual=実線 の出し分け（灰基準）。
  describe('whiteout の auto=破線 / manual=実線', () => {
    it('auto_suggestion は破線（border-dashed）', () => {
      expect(bboxBoxClass('whiteout', false, 'auto_suggestion')).toContain(
        'border-dashed',
      )
      expect(bboxBoxClass('whiteout', true, 'auto_suggestion')).toContain(
        'border-dashed',
      )
    })
    it('manual は実線（border-solid・破線ではない）', () => {
      expect(bboxBoxClass('whiteout', false, 'manual')).toContain('border-solid')
      expect(bboxBoxClass('whiteout', false, 'manual')).not.toContain(
        'border-dashed',
      )
    })
    it('kind 省略時は実線（後方互換）', () => {
      expect(bboxBoxClass('whiteout', false)).toContain('border-solid')
      expect(bboxBoxClass('whiteout', false)).not.toContain('border-dashed')
    })
    it('灰30%透過は維持（編集UIのみ・出力は不透明白）', () => {
      expect(bboxBoxClass('whiteout', false, 'auto_suggestion')).toContain(
        'bg-gray-400/30',
      )
    })
  })
})
