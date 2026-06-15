/**
 * parseContentValues hydration バグ回帰防止 unit test。
 *
 * 真因:
 *   AdjustView で保存 → 詳細画面遷移 → AdjustView に戻る経路で、
 *   Next.js App Router の Router Cache が古い RSC（content_json が空文字状態）を
 *   返してしまい bbox が空表示になる hydration バグ。
 *
 *   修正本体は `saveMinuteAdjust` / `saveBboxOverrides` / `updateMinute` 末尾の
 *   `revalidatePath('/minutes/[id]/adjust')` 追加（src/server/minutes.ts）。
 *
 * 本テストの目的:
 *   page.tsx の `parseContentValues` が DB の content_json から fields[].name 経由で
 *   正しく値を抜き出すこと（将来の改修で key 抜き出しロジックが壊れないようロックする）。
 *
 *   実機シナリオ（家族会議 builtin・fields 5 件）:
 *     - DB content_json: {attendees:'',agenda:'',discussion:'',decisions:'',todos:'p'}
 *     - fields:           [{name:'attendees'},{name:'agenda'},{name:'discussion'},
 *                          {name:'decisions'},{name:'todos'}]
 *     - 期待 initialValues: {attendees:'',agenda:'',discussion:'',decisions:'',todos:'p'}
 */
import { describe, it, expect } from 'vitest'
import { parseContentValues } from '@/app/(dashboard)/minutes/[id]/adjust/page'
import type { TemplateFieldDef } from '@/app/(dashboard)/minutes/[id]/adjust/AdjustView'

function f(name: string, label = name): TemplateFieldDef {
  return { name, label, bbox: { x: 0, y: 0, w: 100, h: 20 }, multiline: false }
}

describe('parseContentValues hydration', () => {
  it('実機シナリオ: 家族会議 builtin・content_json に "p" が入った todos を含む 5 fields を正しく hydrate する', () => {
    const fields = [
      f('attendees', '参加者'),
      f('agenda', '議題'),
      f('discussion', '議事内容'),
      f('decisions', '決定事項'),
      f('todos', 'TODO'),
    ]
    const contentJson = {
      attendees: '',
      agenda: '',
      discussion: '',
      decisions: '',
      todos: 'p',
    }
    const out = parseContentValues(contentJson, fields)
    expect(out).toEqual({
      attendees: '',
      agenda: '',
      discussion: '',
      decisions: '',
      todos: 'p',
    })
  })

  it('content_json の値が fields[].name と key 完全一致で hydrate される（key 名乖離は値欠落として現れる）', () => {
    const fields = [f('attendees'), f('todos')]
    // 仮にキー名が乖離していた場合は空文字 fallback されるという挙動を固定する
    // （構造的に key 一致が必要 = 一致しなければ「空表示」として顕在化する）。
    const contentJson = { wrong_key: 'data', todos: 'p' }
    const out = parseContentValues(contentJson, fields)
    expect(out).toEqual({ attendees: '', todos: 'p' })
  })

  it('content_json が null / undefined / 非 object でも空文字 fallback して controlled state を壊さない', () => {
    const fields = [f('attendees'), f('todos')]
    expect(parseContentValues(null, fields)).toEqual({ attendees: '', todos: '' })
    expect(parseContentValues(undefined, fields)).toEqual({ attendees: '', todos: '' })
    expect(parseContentValues('foo', fields)).toEqual({ attendees: '', todos: '' })
    expect(parseContentValues(123, fields)).toEqual({ attendees: '', todos: '' })
  })

  it('fields が空配列なら空オブジェクトを返す', () => {
    expect(parseContentValues({ a: '1' }, [])).toEqual({})
  })

  it('content_json の値が string でない（数値 / boolean）場合は String() で文字列化される', () => {
    const fields = [f('count'), f('flag')]
    const out = parseContentValues({ count: 42, flag: true }, fields)
    expect(out).toEqual({ count: '42', flag: 'true' })
  })

  it('content_json に余分な key が含まれていても fields に無ければ無視する（型整合）', () => {
    const fields = [f('attendees')]
    const out = parseContentValues({ attendees: 'A', extra: 'X' }, fields)
    expect(out).toEqual({ attendees: 'A' })
    expect('extra' in out).toBe(false)
  })
})
