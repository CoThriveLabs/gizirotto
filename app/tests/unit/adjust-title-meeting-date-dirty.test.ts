/**
 * AdjustView ヘッダーのタイトル / 開催日編集 UI dirty 判定単体テスト。
 *
 * AdjustView 全体 mount は依存が重いため、
 * 「metaDirty = (title !== initialTitle) || (meetingDate !== initialMeetingDate)」
 * 判定の同型純関数を inline 定義して検証する（実装と等価）。
 *
 * 検証観点:
 *   1. 初期値と同一なら dirty=false（保存ボタン非活性）
 *   2. タイトルだけ変えたら dirty=true
 *   3. 開催日だけ変えたら dirty=true
 *   4. 両方変えたら dirty=true
 *   5. 一度変えて元に戻したら dirty=false
 */
import { describe, it, expect } from 'vitest'

/** AdjustView と同型の metaDirty 判定（仕様の単一実装）。 */
function isMetaDirty(
  title: string,
  meetingDate: string,
  initialTitle: string,
  initialMeetingDate: string,
): boolean {
  return title !== initialTitle || meetingDate !== initialMeetingDate
}

describe('AdjustView タイトル / 開催日 dirty 判定', () => {
  const initialTitle = '6月の家族会議'
  const initialMeetingDate = '2026-06-10'

  it('初期値と完全一致なら dirty=false', () => {
    expect(
      isMetaDirty(
        initialTitle,
        initialMeetingDate,
        initialTitle,
        initialMeetingDate,
      ),
    ).toBe(false)
  })

  it('タイトルだけ変更 → dirty=true', () => {
    expect(
      isMetaDirty(
        '7月の家族会議',
        initialMeetingDate,
        initialTitle,
        initialMeetingDate,
      ),
    ).toBe(true)
  })

  it('開催日だけ変更 → dirty=true', () => {
    expect(
      isMetaDirty(
        initialTitle,
        '2026-07-01',
        initialTitle,
        initialMeetingDate,
      ),
    ).toBe(true)
  })

  it('両方変更 → dirty=true', () => {
    expect(
      isMetaDirty('別タイトル', '2026-07-01', initialTitle, initialMeetingDate),
    ).toBe(true)
  })

  it('一度変えて元に戻したら dirty=false（回帰防止）', () => {
    // simulate: user edits then reverts
    let title = initialTitle
    let date = initialMeetingDate
    title = '変更中'
    expect(isMetaDirty(title, date, initialTitle, initialMeetingDate)).toBe(
      true,
    )
    title = initialTitle
    date = '2026-12-01'
    expect(isMetaDirty(title, date, initialTitle, initialMeetingDate)).toBe(
      true,
    )
    date = initialMeetingDate
    expect(isMetaDirty(title, date, initialTitle, initialMeetingDate)).toBe(
      false,
    )
  })

  it('空タイトル（バリデーション対象）でも dirty 判定上は true（保存時に弾く）', () => {
    // onSave 側で空タイトルガード（setErrorMsg）するため、
    // dirty 判定はあくまで「初期値からの差分」だけを見る（empty 検知は別責務）。
    expect(
      isMetaDirty('', initialMeetingDate, initialTitle, initialMeetingDate),
    ).toBe(true)
  })
})
