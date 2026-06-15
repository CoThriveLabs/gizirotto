/**
 * MinutesActions の「ヘッダー右ボタン列」構造確認。
 *
 * 検証:
 *   - ボタン群 wrapper が OutputButtons と同型 (`flex flex-col gap-2 items-end`)
 *   - 内側ボタンリスト wrapper が `flex flex-wrap gap-2 justify-end`
 *   - 編集 が Link、削除が button として bordered button style で出る
 *   - 旧テキストリンク style (`text-sm text-gizirotto-blue-700 hover:underline` 単体) ではない
 *
 * 旧「編集」ボタン廃止・旧「調整」→「編集」リネーム済み。
 * 実体は AdjustView 経路（`/minutes/[id]/adjust`）。`/edit` ルートは後方互換のため残置。
 *
 * ロジックは別ファイル既存テスト不在のため最低限の DOM 構造のみチェック。
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MinutesActions } from '@/app/(dashboard)/minutes/[id]/_components/MinutesActions'

// next/navigation の useRouter mock（test 環境で必要）。
import { vi } from 'vitest'
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('@/server/minutes', () => ({
  deleteMinute: vi.fn(async () => undefined),
}))

describe('MinutesActions ヘッダー右配置', () => {
  it('編集 / 削除 が DOM 上に存在する（旧「編集」廃止・旧「調整」→「編集」リネーム済み）', () => {
    render(<MinutesActions minuteId="m-1" title="テスト" />)
    expect(screen.getByText('編集')).toBeTruthy()
    expect(screen.getByText('削除')).toBeTruthy()
    // 旧「調整」ラベルは UI から消えていること
    expect(screen.queryByText('調整')).toBeNull()
  })

  it('編集 Link の遷移先は AdjustView (/minutes/[id]/adjust)', () => {
    render(<MinutesActions minuteId="m-1" title="テスト" />)
    const editLink = screen.getByText('編集') as HTMLAnchorElement
    expect(editLink.tagName).toBe('A')
    expect(editLink.getAttribute('href')).toBe('/minutes/m-1/adjust')
  })

  it('旧「編集」(/edit) リンクは存在しない（UI から廃止済み）', () => {
    const { container } = render(
      <MinutesActions minuteId="m-1" title="テスト" />,
    )
    const editRouteLinks = Array.from(
      container.querySelectorAll('a[href$="/edit"]'),
    )
    expect(editRouteLinks).toHaveLength(0)
  })

  it('外枠 wrapper が OutputButtons と同型 (flex flex-col gap-2 items-end)', () => {
    const { container } = render(
      <MinutesActions minuteId="m-1" title="テスト" />,
    )
    const outer = container.firstElementChild as HTMLElement
    expect(outer).toBeTruthy()
    expect(outer.className).toContain('flex')
    expect(outer.className).toContain('flex-col')
    expect(outer.className).toContain('gap-2')
    expect(outer.className).toContain('items-end')
  })

  it('内側ボタンリストが flex flex-wrap gap-2 justify-end', () => {
    const { container } = render(
      <MinutesActions minuteId="m-1" title="テスト" />,
    )
    const inner = container.querySelector('.flex.flex-wrap') as HTMLElement
    expect(inner).toBeTruthy()
    expect(inner.className).toContain('justify-end')
  })

  it('編集 Link が bordered button スタイル (border + rounded + px-3 py-2)', () => {
    render(<MinutesActions minuteId="m-1" title="テスト" />)
    const editLink = screen.getByText('編集') as HTMLAnchorElement
    expect(editLink.className).toContain('border')
    expect(editLink.className).toContain('rounded')
    expect(editLink.className).toContain('px-3')
    expect(editLink.className).toContain('py-2')
    // 旧テキストリンク style ではない
    expect(editLink.className).not.toContain('hover:underline')
  })

  it('削除ボタンが button 要素で confirm 系の border-red 警告色', () => {
    render(<MinutesActions minuteId="m-1" title="テスト" />)
    const delBtn = screen.getByText('削除') as HTMLButtonElement
    expect(delBtn.tagName).toBe('BUTTON')
    expect(delBtn.className).toContain('border-red-300')
    expect(delBtn.className).toContain('text-red-600')
  })
})
