import { describe, it, expect, vi } from 'vitest'
import { runLeaveSaves } from '@/app/(dashboard)/templates/[id]/bbox-editor-client'

/**
 * 一覧離脱ガード（#19）の一括保存ロジック runLeaveSaves の単体テスト。
 *
 * 差し戻し対応の核: 「保存して移動」で dirty な**全モード**の save が呼ばれること、
 * dirty=false のモードは呼ばれないこと、順次（直列）に await されること、
 * 失敗モードのラベルが返ること、を固定する（白塗りが保存されないバグの再発防止）。
 */
describe('runLeaveSaves', () => {
  it('dirty なモードの save だけを呼ぶ（白塗りのみ dirty）', async () => {
    const fieldSave = vi.fn(async () => true)
    const whiteoutSave = vi.fn(async () => true)
    const fixedSave = vi.fn(async () => true)

    const failed = await runLeaveSaves([
      { dirty: false, label: '記入欄', save: fieldSave },
      { dirty: true, label: '白塗り', save: whiteoutSave },
      { dirty: false, label: '固定テキスト', save: fixedSave },
    ])

    expect(fieldSave).not.toHaveBeenCalled()
    expect(whiteoutSave).toHaveBeenCalledTimes(1)
    expect(fixedSave).not.toHaveBeenCalled()
    expect(failed).toEqual([])
  })

  it('固定テキストのみ dirty なら固定の save だけ呼ぶ', async () => {
    const fieldSave = vi.fn(async () => true)
    const whiteoutSave = vi.fn(async () => true)
    const fixedSave = vi.fn(async () => true)

    const failed = await runLeaveSaves([
      { dirty: false, label: '記入欄', save: fieldSave },
      { dirty: false, label: '白塗り', save: whiteoutSave },
      { dirty: true, label: '固定テキスト', save: fixedSave },
    ])

    expect(fieldSave).not.toHaveBeenCalled()
    expect(whiteoutSave).not.toHaveBeenCalled()
    expect(fixedSave).toHaveBeenCalledTimes(1)
    expect(failed).toEqual([])
  })

  it('全モード dirty なら 3 つすべて呼ぶ', async () => {
    const fieldSave = vi.fn(async () => true)
    const whiteoutSave = vi.fn(async () => true)
    const fixedSave = vi.fn(async () => true)

    const failed = await runLeaveSaves([
      { dirty: true, label: '記入欄', save: fieldSave },
      { dirty: true, label: '白塗り', save: whiteoutSave },
      { dirty: true, label: '固定テキスト', save: fixedSave },
    ])

    expect(fieldSave).toHaveBeenCalledTimes(1)
    expect(whiteoutSave).toHaveBeenCalledTimes(1)
    expect(fixedSave).toHaveBeenCalledTimes(1)
    expect(failed).toEqual([])
  })

  it('順次（直列）に await する（前の save 完了後に次を呼ぶ）', async () => {
    const order: string[] = []
    const make = (label: string) =>
      vi.fn(async () => {
        order.push(`${label}:start`)
        await Promise.resolve()
        order.push(`${label}:end`)
        return true
      })
    const fieldSave = make('記入欄')
    const whiteoutSave = make('白塗り')

    await runLeaveSaves([
      { dirty: true, label: '記入欄', save: fieldSave },
      { dirty: true, label: '白塗り', save: whiteoutSave },
    ])

    // 直列: 記入欄が end してから白塗りが start する。
    expect(order).toEqual([
      '記入欄:start',
      '記入欄:end',
      '白塗り:start',
      '白塗り:end',
    ])
  })

  it('失敗したモードのラベルを返す（部分失敗）', async () => {
    const failed = await runLeaveSaves([
      { dirty: true, label: '記入欄', save: async () => true },
      { dirty: true, label: '白塗り', save: async () => false },
      { dirty: true, label: '固定テキスト', save: async () => false },
    ])
    expect(failed).toEqual(['白塗り', '固定テキスト'])
  })

  it('dirty が全部 false なら何も呼ばず空配列', async () => {
    const save = vi.fn(async () => true)
    const failed = await runLeaveSaves([
      { dirty: false, label: '記入欄', save },
      { dirty: false, label: '白塗り', save },
      { dirty: false, label: '固定テキスト', save },
    ])
    expect(save).not.toHaveBeenCalled()
    expect(failed).toEqual([])
  })
})
