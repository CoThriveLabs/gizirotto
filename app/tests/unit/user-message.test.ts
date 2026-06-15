import { describe, it, expect } from 'vitest'
import {
  humanizeErrorCode,
  containsJapanese,
  ERROR_CATALOG,
} from '@/lib/errors/user-message'

describe('humanizeErrorCode（既知コード → 個別文言）', () => {
  it('NOT_A_PDF_TEMPLATE → A・個別文言', () => {
    const r = humanizeErrorCode('NOT_A_PDF_TEMPLATE')
    expect(r.category).toBe('A')
    expect(r.message).toContain('PDF のテンプレート')
    expect(r.rawCode).toBe('NOT_A_PDF_TEMPLATE')
  })

  it('BBOX_OUT_OF_RANGE → A・はみ出し文言', () => {
    const r = humanizeErrorCode('BBOX_OUT_OF_RANGE')
    expect(r.category).toBe('A')
    expect(r.message).toContain('はみ出して')
  })

  it('UNAUTHENTICATED → D・再ログイン文言', () => {
    const r = humanizeErrorCode('UNAUTHENTICATED')
    expect(r.category).toBe('D')
    expect(r.message).toContain('ログイン')
  })

  it('CONFLICT → D・再読み込み文言', () => {
    const r = humanizeErrorCode('CONFLICT')
    expect(r.category).toBe('D')
    expect(r.message).toContain('再読み込み')
  })

  it('ANTHROPIC_API_KEY_MISSING → C・管理者文言（カテゴリ既定）', () => {
    const r = humanizeErrorCode('ANTHROPIC_API_KEY_MISSING')
    expect(r.category).toBe('C')
    expect(r.message).toContain('管理者')
  })

  it('WHITEOUT_RASTERIZE_FAILED → A・カテゴリ既定文言（個別 message なし）', () => {
    const r = humanizeErrorCode('WHITEOUT_RASTERIZE_FAILED')
    expect(r.category).toBe('A')
    expect(r.message).toContain('読み込めない形式')
  })

  it('DB_ERROR → B・一時的文言', () => {
    const r = humanizeErrorCode('DB_ERROR')
    expect(r.category).toBe('B')
    expect(r.message).toContain('一時的')
  })
})

describe('humanizeErrorCode（family/join 系・P2 横展開で追加）', () => {
  it('INVALID_CODE → D・招待コード文言', () => {
    const r = humanizeErrorCode('INVALID_CODE')
    expect(r.category).toBe('D')
    expect(r.message).toContain('招待コード')
    expect(r.rawCode).toBe('INVALID_CODE')
  })

  it('CODE_EXPIRED → D・有効期限文言', () => {
    const r = humanizeErrorCode('CODE_EXPIRED')
    expect(r.category).toBe('D')
    expect(r.message).toContain('有効期限')
    expect(r.rawCode).toBe('CODE_EXPIRED')
  })

  it('ALREADY_IN_FAMILY → D・所属済み文言', () => {
    const r = humanizeErrorCode('ALREADY_IN_FAMILY')
    expect(r.category).toBe('D')
    expect(r.message).toContain('既に')
    expect(r.rawCode).toBe('ALREADY_IN_FAMILY')
  })

  it('INVALID_DISPLAY_NAME → D・表示名文言（INVALID_CODE と誤マッチしない）', () => {
    const r = humanizeErrorCode('INVALID_DISPLAY_NAME')
    expect(r.category).toBe('D')
    expect(r.message).toContain('表示名')
    expect(r.rawCode).toBe('INVALID_DISPLAY_NAME')
  })

  it('未知コードに落ちない（4コードとも既知化される）', () => {
    for (const code of [
      'INVALID_CODE',
      'CODE_EXPIRED',
      'ALREADY_IN_FAMILY',
      'INVALID_DISPLAY_NAME',
    ]) {
      expect(ERROR_CATALOG[code]).toBeDefined()
      // 既知化されていれば rawCode は入力コードそのもの（フォールバック短縮ではない）
      expect(humanizeErrorCode(code).rawCode).toBe(code)
    }
  })
})

describe('containsJapanese', () => {
  it('日本語（かな/カナ/漢字）を含むと true', () => {
    expect(containsJapanese('ログインに失敗しました')).toBe(true)
    expect(containsJapanese('カタカナ')).toBe(true)
    expect(containsJapanese('漢字')).toBe(true)
  })

  it('英文/コード/空は false', () => {
    expect(containsJapanese('Invalid login credentials')).toBe(false)
    expect(containsJapanese('OUTPUT_FAILED')).toBe(false)
    expect(containsJapanese('')).toBe(false)
    expect(containsJapanese(null)).toBe(false)
    expect(containsJapanese(undefined)).toBe(false)
  })
})

describe('humanizeErrorCode（合成文字列からのコード抽出）', () => {
  it('「preview failed: 500 {error:WHITEOUT_RASTERIZE_FAILED}」から既知コードを最長一致抽出', () => {
    const r = humanizeErrorCode('preview failed: 500 WHITEOUT_RASTERIZE_FAILED')
    expect(r.rawCode).toBe('WHITEOUT_RASTERIZE_FAILED')
    expect(r.category).toBe('A')
  })

  it('最長一致: DB_UPDATE_FAILED が DB_ERROR より優先される', () => {
    const r = humanizeErrorCode('DB_UPDATE_FAILED')
    expect(r.rawCode).toBe('DB_UPDATE_FAILED')
    expect(r.category).toBe('B')
  })
})

describe('humanizeErrorCode（未知コード → フォールバック規則）', () => {
  it('*_FAILED → B', () => {
    const r = humanizeErrorCode('SOMETHING_WEIRD_FAILED')
    expect(r.category).toBe('B')
    expect(r.message).toContain('一時的')
    expect(r.rawCode).toBe('SOMETHING_WEIRD_FAILED')
  })

  it('*_MISSING → C', () => {
    const r = humanizeErrorCode('SOME_NEW_KEY_MISSING')
    expect(r.category).toBe('C')
    expect(r.message).toContain('管理者')
  })

  it('HTTP 4xx（コード様トークンなし）→ D・rawCode=HTTP_403', () => {
    const r = humanizeErrorCode('request failed: 403')
    expect(r.category).toBe('D')
    expect(r.rawCode).toBe('HTTP_403')
  })

  it('HTTP 5xx（コード様トークンなし）→ B・rawCode=HTTP_502', () => {
    const r = humanizeErrorCode('upstream error 502')
    expect(r.category).toBe('B')
    expect(r.rawCode).toBe('HTTP_502')
  })

  it('語尾もステータスも該当なし → E（予期しない）', () => {
    const r = humanizeErrorCode('totally unknown thing')
    expect(r.category).toBe('E')
    expect(r.message).toContain('予期しない')
  })

  it('空文字/未定義 → E・rawCode=UNKNOWN', () => {
    expect(humanizeErrorCode('').category).toBe('E')
    expect(humanizeErrorCode('').rawCode).toBe('UNKNOWN')
    expect(humanizeErrorCode(null).category).toBe('E')
    expect(humanizeErrorCode(undefined).category).toBe('E')
  })
})

describe('humanizeErrorCode（グループB bbox編集系・Phase B-1 で追加）', () => {
  it('FIELD_COUNT_OUT_OF_RANGE → D・件数文言（BBOX_OUT_OF_RANGE と誤マッチしない）', () => {
    const r = humanizeErrorCode('FIELD_COUNT_OUT_OF_RANGE')
    expect(r.category).toBe('D')
    expect(r.message).toContain('20')
    expect(r.rawCode).toBe('FIELD_COUNT_OUT_OF_RANGE')
  })

  it('INVALID_LABEL → D・項目名文言', () => {
    const r = humanizeErrorCode('INVALID_LABEL')
    expect(r.category).toBe('D')
    expect(r.message).toContain('項目名')
    expect(r.rawCode).toBe('INVALID_LABEL')
  })

  it('NAME_GEN_FAILED → D・既知コード（_FAILED フォールバックBに落ちない）', () => {
    const r = humanizeErrorCode('NAME_GEN_FAILED')
    expect(r.category).toBe('D')
    expect(r.rawCode).toBe('NAME_GEN_FAILED')
  })

  it('3コードとも既知化される（未知フォールバックに落ちない）', () => {
    for (const code of ['FIELD_COUNT_OUT_OF_RANGE', 'INVALID_LABEL', 'NAME_GEN_FAILED']) {
      expect(ERROR_CATALOG[code]).toBeDefined()
      expect(humanizeErrorCode(code).rawCode).toBe(code)
    }
  })
})

describe('ERROR_CATALOG 整合', () => {
  it('全エントリのカテゴリは A〜E のいずれか', () => {
    for (const entry of Object.values(ERROR_CATALOG)) {
      expect(['A', 'B', 'C', 'D', 'E']).toContain(entry.category)
    }
  })

  it('bbox-editor の旧6コードを全て収録（後方互換）', () => {
    for (const code of [
      'CONFLICT',
      'CANNOT_EDIT_DEFAULT',
      'NOT_A_PDF_TEMPLATE',
      'BBOX_OUT_OF_RANGE',
      'NAME_SET_MISMATCH',
      'PAGE_NOT_FOUND',
    ]) {
      expect(ERROR_CATALOG[code]).toBeDefined()
    }
  })
})
