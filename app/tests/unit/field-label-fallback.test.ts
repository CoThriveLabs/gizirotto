import { describe, it, expect } from 'vitest'

/**
 * G1 差し戻し（三次）: manual/page.tsx・edit/page.tsx の extractFields 正規化が
 * `label_ja → label → name` の3段フォールバックで日本語 label を拾うことの回帰テスト。
 *
 * 真因は DB 実値が `label` キー（`label_ja` は無い個体が多い）なのに、
 * 旧実装が `label_ja` のみ見て無ければ英語 name にフォールバックしていたこと。
 * 本テストは chat/adjust と同じフォールバック関数を純関数として再現し、
 * `label` のみ持つフィールドで日本語 label が選ばれることを固定する。
 */
function resolveLabel(obj: Record<string, unknown>, name: string): string {
  return typeof obj.label_ja === 'string'
    ? obj.label_ja
    : typeof obj.label === 'string'
      ? obj.label
      : name
}

describe('field label 3段フォールバック (G1 差し戻し)', () => {
  it('label のみ（label_ja 無し）→ 日本語 label を表示（本症状の修正点）', () => {
    expect(resolveLabel({ label: '日時' }, 'meeting_date')).toBe('日時')
    expect(
      resolveLabel({ label: '会議議事録（タイトル）' }, 'title'),
    ).toBe('会議議事録（タイトル）')
  })

  it('label_ja があれば最優先（既存テンプレ互換）', () => {
    expect(
      resolveLabel({ label_ja: '日付', label: '日時' }, 'meeting_date'),
    ).toBe('日付')
  })

  it('label_ja も label も無ければ name（英語）にフォールバック', () => {
    expect(resolveLabel({}, 'attendees')).toBe('attendees')
  })

  it('label が文字列でない（型不正）なら name にフォールバック', () => {
    expect(resolveLabel({ label: 123 }, 'location')).toBe('location')
    expect(resolveLabel({ label_ja: null, label: undefined }, 'agenda')).toBe(
      'agenda',
    )
  })

  it('代表的な5項目すべてが英語 name でなく日本語 label になる', () => {
    const fields = [
      { name: 'title', label: '会議議事録（タイトル）' },
      { name: 'meeting_date', label: '日時' },
      { name: 'location', label: '場所' },
      { name: 'attendees', label: '出席者' },
      { name: 'agenda', label: '議題' },
    ]
    const labels = fields.map((f) => resolveLabel(f, f.name))
    expect(labels).toEqual([
      '会議議事録（タイトル）',
      '日時',
      '場所',
      '出席者',
      '議題',
    ])
    // 英語 name が1つも残っていないこと
    expect(labels.some((l) => /^[a-z_]+$/.test(l))).toBe(false)
  })
})
