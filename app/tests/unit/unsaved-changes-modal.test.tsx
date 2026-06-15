/**
 * UnsavedChangesModal 単体テスト (設計書 §5-1 全 15 ケース)。
 *
 * 設計書: docs/designs/unsaved_changes_modal_design_2026-06-14.md
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { UnsavedChangesModal } from '@/components/editor/UnsavedChangesModal'

afterEach(() => {
  cleanup()
})

describe('UnsavedChangesModal', () => {
  function noop() {}

  it('#1: open=false で何も描画されない', () => {
    const { container } = render(
      <UnsavedChangesModal
        open={false}
        onSave={noop}
        onDiscard={noop}
        onCancel={noop}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('#2: open=true でタイトル / 説明 / 3 ボタン描画', () => {
    render(
      <UnsavedChangesModal
        open
        onSave={noop}
        onDiscard={noop}
        onCancel={noop}
      />,
    )
    expect(screen.getByText('保存していない変更があります')).toBeTruthy()
    expect(screen.getByText('移動する前に、編集した内容を保存しますか？')).toBeTruthy()
    expect(screen.getByRole('button', { name: '保存して移動' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '保存せず移動' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'キャンセル' })).toBeTruthy()
  })

  it('#3: title / description / saveLabel 等のカスタマイズ反映', () => {
    render(
      <UnsavedChangesModal
        open
        title="カスタム見出し"
        description="カスタム説明"
        saveLabel="保存A"
        discardLabel="破棄B"
        cancelLabel="戻るC"
        onSave={noop}
        onDiscard={noop}
        onCancel={noop}
      />,
    )
    expect(screen.getByText('カスタム見出し')).toBeTruthy()
    expect(screen.getByText('カスタム説明')).toBeTruthy()
    expect(screen.getByRole('button', { name: '保存A' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '破棄B' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '戻るC' })).toBeTruthy()
  })

  it('#4: 保存ボタンクリック → onSave 呼ばれる', () => {
    const onSave = vi.fn()
    render(
      <UnsavedChangesModal
        open
        onSave={onSave}
        onDiscard={noop}
        onCancel={noop}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '保存して移動' }))
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('#5: 破棄ボタンクリック → onDiscard 呼ばれる', () => {
    const onDiscard = vi.fn()
    render(
      <UnsavedChangesModal
        open
        onSave={noop}
        onDiscard={onDiscard}
        onCancel={noop}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '保存せず移動' }))
    expect(onDiscard).toHaveBeenCalledTimes(1)
  })

  it('#6: キャンセルボタンクリック → onCancel 呼ばれる', () => {
    const onCancel = vi.fn()
    render(
      <UnsavedChangesModal
        open
        onSave={noop}
        onDiscard={noop}
        onCancel={onCancel}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('#7: Esc キー → onCancel 呼ばれる', () => {
    const onCancel = vi.fn()
    render(
      <UnsavedChangesModal
        open
        onSave={noop}
        onDiscard={noop}
        onCancel={onCancel}
      />,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('#8: 背景クリック → onCancel 呼ばれる', () => {
    const onCancel = vi.fn()
    render(
      <UnsavedChangesModal
        open
        onSave={noop}
        onDiscard={noop}
        onCancel={onCancel}
      />,
    )
    // role="dialog" のオーバーレイ自体をクリック
    fireEvent.click(screen.getByRole('dialog'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('#9: パネル内クリック → onCancel 呼ばれない (stopPropagation)', () => {
    const onCancel = vi.fn()
    render(
      <UnsavedChangesModal
        open
        onSave={noop}
        onDiscard={noop}
        onCancel={onCancel}
      />,
    )
    // タイトル h3 はパネル内なので親 overlay へバブルしない
    fireEvent.click(screen.getByText('保存していない変更があります'))
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('#10: saving=true で 3 ボタン disabled', () => {
    render(
      <UnsavedChangesModal
        open
        saving
        onSave={noop}
        onDiscard={noop}
        onCancel={noop}
      />,
    )
    expect(
      (screen.getByRole('button', { name: '保存しています…' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: '保存せず移動' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'キャンセル' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('#11: saving=true で 保存ラベルが savingLabel に切替', () => {
    render(
      <UnsavedChangesModal
        open
        saving
        savingLabel="保存中ABC"
        onSave={noop}
        onDiscard={noop}
        onCancel={noop}
      />,
    )
    expect(screen.getByRole('button', { name: '保存中ABC' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '保存して移動' })).toBeNull()
  })

  it('#12: saving=true で Esc / 背景クリック無視', () => {
    const onCancel = vi.fn()
    render(
      <UnsavedChangesModal
        open
        saving
        onSave={noop}
        onDiscard={noop}
        onCancel={onCancel}
      />,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('dialog'))
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('#13: error 渡すと赤背景で表示', () => {
    render(
      <UnsavedChangesModal
        open
        error="保存に失敗しました"
        onSave={noop}
        onDiscard={noop}
        onCancel={noop}
      />,
    )
    const errorEl = screen.getByText('保存に失敗しました')
    expect(errorEl).toBeTruthy()
    expect(errorEl.className).toContain('text-red-700')
    expect(errorEl.className).toContain('bg-red-50')
  })

  it('#14: error=null で エラー欄非表示', () => {
    render(
      <UnsavedChangesModal
        open
        error={null}
        onSave={noop}
        onDiscard={noop}
        onCancel={noop}
      />,
    )
    // 赤背景のエラー欄が存在しないこと (本文 description しか p 要素は無い)
    const ps = document.querySelectorAll('p.text-red-700')
    expect(ps.length).toBe(0)
  })

  it('#15: マウント時にキャンセルボタンが focus 取得', () => {
    render(
      <UnsavedChangesModal
        open
        onSave={noop}
        onDiscard={noop}
        onCancel={noop}
      />,
    )
    const cancelBtn = screen.getByRole('button', { name: 'キャンセル' })
    expect(document.activeElement).toBe(cancelBtn)
  })
})
