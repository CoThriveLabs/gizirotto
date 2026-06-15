/**
 * minutes-adjust-draft 純関数 unit test
 * （段階 3 B・設計書 minutes_adjust_editor_renewal_design_2026-06-08 §5-1 lazy create / §8-4）。
 *
 * 検証観点:
 *   - read/write/clear の往復一貫性
 *   - storage=null（SSR）で no-op
 *   - 不正 JSON / 部分欠損 / 型不一致を null 返却で握り潰す
 *   - emptyManualAdjustDraft が全 field を空文字で初期化
 *   - キーが既存 `minutes:draft`（confirm 経路）と衝突しない
 */
import { describe, it, expect } from 'vitest'
import {
  MINUTES_ADJUST_DRAFT_KEY,
  readManualAdjustDraft,
  writeManualAdjustDraft,
  clearManualAdjustDraft,
  emptyManualAdjustDraft,
  type DraftStorage,
} from '@/lib/utils/minutes-adjust-draft'

function makeMemoryStorage(): DraftStorage & { _data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    _data: data,
    getItem(key) {
      return data.has(key) ? data.get(key)! : null
    },
    setItem(key, value) {
      data.set(key, value)
    },
    removeItem(key) {
      data.delete(key)
    },
  }
}

describe('MINUTES_ADJUST_DRAFT_KEY', () => {
  it('既存 ManualForm/confirm 経路の minutes:draft と衝突しない別キー', () => {
    expect(MINUTES_ADJUST_DRAFT_KEY).toBe('minutes:adjust-draft')
    expect(MINUTES_ADJUST_DRAFT_KEY).not.toBe('minutes:draft')
  })
})

describe('readManualAdjustDraft', () => {
  it('storage=null（SSR）は null', () => {
    expect(readManualAdjustDraft(null)).toBeNull()
  })

  it('未保存（key 無し）は null', () => {
    expect(readManualAdjustDraft(makeMemoryStorage())).toBeNull()
  })

  it('write→read 往復で同値', () => {
    const s = makeMemoryStorage()
    const draft = {
      templateId: 'tpl-1',
      values: { title: 'こんにちは', body: 'やあ' },
      overrides: { title: { x: 10, y: 20 } },
    }
    writeManualAdjustDraft(s, draft)
    expect(readManualAdjustDraft(s)).toEqual(draft)
  })

  it('JSON.parse 失敗は null（壊れたデータ）', () => {
    const s = makeMemoryStorage()
    s.setItem(MINUTES_ADJUST_DRAFT_KEY, '{not json')
    expect(readManualAdjustDraft(s)).toBeNull()
  })

  it('templateId 欠損は null（lazy create に必須）', () => {
    const s = makeMemoryStorage()
    s.setItem(
      MINUTES_ADJUST_DRAFT_KEY,
      JSON.stringify({ values: {}, overrides: {} }),
    )
    expect(readManualAdjustDraft(s)).toBeNull()
  })

  it('templateId が string でない型不一致は null', () => {
    const s = makeMemoryStorage()
    s.setItem(
      MINUTES_ADJUST_DRAFT_KEY,
      JSON.stringify({ templateId: 123, values: {}, overrides: {} }),
    )
    expect(readManualAdjustDraft(s)).toBeNull()
  })

  it('values が object でないと null', () => {
    const s = makeMemoryStorage()
    s.setItem(
      MINUTES_ADJUST_DRAFT_KEY,
      JSON.stringify({ templateId: 't', values: 'oops', overrides: {} }),
    )
    expect(readManualAdjustDraft(s)).toBeNull()
  })

  it('values の非 string 値は空文字 or String() フォールバック', () => {
    const s = makeMemoryStorage()
    s.setItem(
      MINUTES_ADJUST_DRAFT_KEY,
      JSON.stringify({
        templateId: 't',
        values: { a: null, b: 123, c: 'ok' },
        overrides: {},
      }),
    )
    const result = readManualAdjustDraft(s)
    expect(result).not.toBeNull()
    expect(result!.values.a).toBe('') // null→''
    expect(result!.values.b).toBe('123') // number→String
    expect(result!.values.c).toBe('ok')
  })

  it('overrides 欠損は空 {} に正規化（位置情報無くてもよい）', () => {
    const s = makeMemoryStorage()
    s.setItem(
      MINUTES_ADJUST_DRAFT_KEY,
      JSON.stringify({ templateId: 't', values: {} }),
    )
    expect(readManualAdjustDraft(s)).toEqual({
      templateId: 't',
      values: {},
      overrides: {},
    })
  })
})

describe('writeManualAdjustDraft / clearManualAdjustDraft', () => {
  it('storage=null は no-op（throw しない）', () => {
    const draft = { templateId: 't', values: {}, overrides: {} }
    expect(() => writeManualAdjustDraft(null, draft)).not.toThrow()
    expect(() => clearManualAdjustDraft(null)).not.toThrow()
  })

  it('clear で読み出しが null に戻る', () => {
    const s = makeMemoryStorage()
    writeManualAdjustDraft(s, {
      templateId: 't',
      values: { a: 'x' },
      overrides: {},
    })
    expect(readManualAdjustDraft(s)).not.toBeNull()
    clearManualAdjustDraft(s)
    expect(readManualAdjustDraft(s)).toBeNull()
  })
})

describe('emptyManualAdjustDraft', () => {
  it('全 field を空文字で初期化、overrides は空 {}', () => {
    expect(emptyManualAdjustDraft('tpl-x', ['title', 'date', 'memo'])).toEqual({
      templateId: 'tpl-x',
      values: { title: '', date: '', memo: '' },
      overrides: {},
    })
  })

  it('fieldNames=[] でも valid な draft（空 values）', () => {
    expect(emptyManualAdjustDraft('t', [])).toEqual({
      templateId: 't',
      values: {},
      overrides: {},
    })
  })
})
