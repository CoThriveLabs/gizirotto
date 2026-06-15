/**
 * 著作権予防策 unit test（Phase 2.5 Week 5 / 設計書 v1.4.2 §9）。
 *
 * 検証対象:
 *   - license-text: 文言定数 + 削除窓口メール
 *   - license-consent: buildLicenseConsent + isLicenseConsentRecord
 *   - logo-detector L1: detectLogosByKeyword
 *   - logo-detector L2: fake Claude client で confirmLogoByClaudeVision
 *   - detectCommercialLogos: L1 + L2 統合の結合動作
 *   - known-logos: 初期 10 件確認
 *
 * 重要（C-9 厳守）:
 *   本テストでは「自動拒否」「自動禁止」を一切確認しない。
 *   needsUserConfirmation=true で「ユーザー UI で選ばせる」入口に到達することのみ確認。
 */
import { describe, it, expect } from 'vitest'
import {
  LICENSE_COPYRIGHT_CLAUSE,
  TAKEDOWN_CONTACT_EMAIL,
  TAKEDOWN_RESPONSE_DAYS,
  UPLOAD_CONSENT_CHECKBOX_LABEL,
  INPUT_PATH_LABELS,
  COMMERCIAL_LOGO_WARNING_BUTTONS,
  buildLicenseConsent,
  isLicenseConsentRecord,
  detectLogosByKeyword,
  detectCommercialLogos,
  confirmLogoByClaudeVision,
  KNOWN_COMMERCIAL_LOGOS,
  getKnownLogoById,
  getAllKeywordHints,
  type ClaudeVisionClient,
} from '@/lib/copyright'

process.env.ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-test-model'

describe('license-text 定数', () => {
  it('削除窓口メール = contact@cothrivelabs.com', () => {
    expect(TAKEDOWN_CONTACT_EMAIL).toBe('contact@cothrivelabs.com')
  })
  it('削除対応期限 = 14 日（仕様書 §0-3.5 要件 4）', () => {
    expect(TAKEDOWN_RESPONSE_DAYS).toBe(14)
  })
  it('利用規約条文に第 X 条 + 第 Y 条 + メールアドレスが含まれる', () => {
    expect(LICENSE_COPYRIGHT_CLAUSE).toContain('第 X 条')
    expect(LICENSE_COPYRIGHT_CLAUSE).toContain('第 Y 条')
    expect(LICENSE_COPYRIGHT_CLAUSE).toContain('contact@cothrivelabs.com')
    expect(LICENSE_COPYRIGHT_CLAUSE).toContain('Co-Thrive Labs')
    // 旧運営者ハンドル名が利用規約本文に混入していないことを防御するテスト。
    // 公開リポにハンドル名リテラルを残さないため動的構築する（露出防止）。
    const FORBIDDEN_LEGACY_OPERATOR_NAME = String.fromCharCode(
      0x3042,
      0x3081,
      0x307e,
      0x307f,
      0x308c,
    )
    expect(LICENSE_COPYRIGHT_CLAUSE).not.toContain(FORBIDDEN_LEGACY_OPERATOR_NAME)
  })
  it('利用規約条文に「自動拒否」「自動禁止」「自動却下」が含まれない（C-9 厳守）', () => {
    expect(LICENSE_COPYRIGHT_CLAUSE).not.toContain('自動拒否')
    expect(LICENSE_COPYRIGHT_CLAUSE).not.toContain('自動禁止')
    expect(LICENSE_COPYRIGHT_CLAUSE).not.toContain('自動却下')
  })
  it('UPLOAD_CONSENT_CHECKBOX_LABEL は Q5 草案準拠', () => {
    expect(UPLOAD_CONSENT_CHECKBOX_LABEL).toContain('自己作成または正当に取得した')
  })
  it('INPUT_PATH_LABELS は Q5 承認済文言（A/B 両方）', () => {
    expect(INPUT_PATH_LABELS.A).toBe('未記入のテンプレート（推奨）')
    expect(INPUT_PATH_LABELS.B).toBe('書き込み済みのファイル → 自動で空白に戻す')
  })
  it('COMMERCIAL_LOGO_WARNING_BUTTONS は「それでも続ける」「キャンセル」', () => {
    expect(COMMERCIAL_LOGO_WARNING_BUTTONS.proceed).toBe('それでも続ける')
    expect(COMMERCIAL_LOGO_WARNING_BUTTONS.cancel).toBe('キャンセル')
  })
})

describe('buildLicenseConsent', () => {
  it('userId + 現在時刻でレコードを組み立てる', () => {
    const r = buildLicenseConsent('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    expect(r.user_id).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    expect(typeof r.agreed_at).toBe('string')
    // ISO8601
    expect(r.agreed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })
  it('明示的な Date を渡せる', () => {
    const at = new Date('2026-05-24T12:00:00Z')
    const r = buildLicenseConsent('user-1', at)
    expect(r.agreed_at).toBe('2026-05-24T12:00:00.000Z')
  })
  it('userId 空はエラー', () => {
    expect(() => buildLicenseConsent('')).toThrow('LICENSE_CONSENT_USER_ID_REQUIRED')
  })
})

describe('isLicenseConsentRecord', () => {
  it('正常レコード判定', () => {
    expect(
      isLicenseConsentRecord({
        user_id: 'u',
        agreed_at: '2026-05-24T00:00:00Z',
      }),
    ).toBe(true)
  })
  it('user_id 欠落は false', () => {
    expect(isLicenseConsentRecord({ agreed_at: '2026-05-24T00:00:00Z' })).toBe(false)
  })
  it('agreed_at 空文字列は false', () => {
    expect(isLicenseConsentRecord({ user_id: 'u', agreed_at: '' })).toBe(false)
  })
  it('null / undefined / 非オブジェクトは false', () => {
    expect(isLicenseConsentRecord(null)).toBe(false)
    expect(isLicenseConsentRecord(undefined)).toBe(false)
    expect(isLicenseConsentRecord('string')).toBe(false)
  })
})

describe('KNOWN_COMMERCIAL_LOGOS 初期 DB', () => {
  it('初期 10 件登録済', () => {
    expect(KNOWN_COMMERCIAL_LOGOS.length).toBe(10)
  })
  it('各エントリに必須フィールド揃う', () => {
    for (const logo of KNOWN_COMMERCIAL_LOGOS) {
      expect(logo.id).toMatch(/^[a-z_]+$/)
      expect(logo.vendor.length).toBeGreaterThan(0)
      expect(logo.warningLabel.length).toBeGreaterThan(0)
      expect(logo.keywordHints.length).toBeGreaterThan(0)
    }
  })
  it('getKnownLogoById で取得可能', () => {
    expect(getKnownLogoById('bizocean')?.vendor).toContain('ビズオーシャン')
    expect(getKnownLogoById('does-not-exist')).toBeUndefined()
  })
  it('getAllKeywordHints がフラットリストを返す', () => {
    const hints = getAllKeywordHints()
    expect(hints.length).toBeGreaterThanOrEqual(KNOWN_COMMERCIAL_LOGOS.length)
    expect(hints).toContain('bizocean')
  })
})

describe('detectLogosByKeyword (L1)', () => {
  it('bizocean キーワード含む markdown を検出', () => {
    const matches = detectLogosByKeyword([
      '部署: 開発部\n氏名: 山田\n\n出典: bizocean.jp テンプレート',
    ])
    expect(matches).toHaveLength(1)
    expect(matches[0].logo.id).toBe('bizocean')
    expect(matches[0].reason).toBe('keyword_match')
    expect(matches[0].confidence).toBe(1.0)
    expect(matches[0].evidence).toBe('bizocean')
  })
  it('大文字小文字を無視', () => {
    const matches = detectLogosByKeyword(['Canva で作成しました'])
    expect(matches.find(m => m.logo.id === 'canva')).toBeDefined()
  })
  it('複数 logo を同時検出', () => {
    const matches = detectLogosByKeyword([
      'bizocean のテンプレート、Canva で編集',
    ])
    const ids = matches.map(m => m.logo.id).sort()
    expect(ids).toContain('bizocean')
    expect(ids).toContain('canva')
  })
  it('一致なしは空配列', () => {
    expect(detectLogosByKeyword(['普通の議事録テキスト'])).toEqual([])
    expect(detectLogosByKeyword([])).toEqual([])
  })
})

describe('confirmLogoByClaudeVision (L2、fake client)', () => {
  function fakeClientReturning(text: string): ClaudeVisionClient {
    return {
      messages: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async create(..._args: any[]) {
          return { content: [{ type: 'text', text }] }
        },
      } as unknown as ClaudeVisionClient['messages'],
    }
  }

  const dummyImage = new Uint8Array([0x89, 0x50, 0x4e, 0x47]) // PNG magic

  it('has_logo: true レスポンスを解釈', async () => {
    const client = fakeClientReturning(
      '{"has_logo": true, "evidence": "右上に Canva ロゴあり"}',
    )
    const r = await confirmLogoByClaudeVision(
      { pageImagePngBytes: dummyImage },
      { client },
    )
    expect(r.hasLogo).toBe(true)
    expect(r.evidence).toContain('Canva')
  })

  it('has_logo: false レスポンスを解釈', async () => {
    const client = fakeClientReturning(
      '{"has_logo": false, "evidence": "通常の議事録テンプレート"}',
    )
    const r = await confirmLogoByClaudeVision(
      { pageImagePngBytes: dummyImage },
      { client },
    )
    expect(r.hasLogo).toBe(false)
  })

  it('JSON 不正は fail-safe で hasLogo=false', async () => {
    const client = fakeClientReturning('応答が JSON ではないテキスト')
    const r = await confirmLogoByClaudeVision(
      { pageImagePngBytes: dummyImage },
      { client },
    )
    expect(r.hasLogo).toBe(false)
  })

  it('Claude が text block を返さなければ hasLogo=false', async () => {
    const client: ClaudeVisionClient = {
      messages: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async create(..._args: any[]) {
          return { content: [{ type: 'image', source: {} }] }
        },
      } as unknown as ClaudeVisionClient['messages'],
    }
    const r = await confirmLogoByClaudeVision(
      { pageImagePngBytes: dummyImage },
      { client },
    )
    expect(r.hasLogo).toBe(false)
  })
})

describe('detectCommercialLogos (L1 + L2 統合)', () => {
  it('L1 マッチがあれば needsUserConfirmation=true、L2 は skip', async () => {
    const r = await detectCommercialLogos({
      textSources: ['bizocean のテンプレ'],
      pageImages: [new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
      // claudeClient を渡さないが、L1 マッチで L2 skip されるため Anthropic API 呼ばれない
    })
    expect(r.needsUserConfirmation).toBe(true)
    expect(r.matches).toHaveLength(1)
    expect(r.matches[0].logo.id).toBe('bizocean')
  })

  it('L1 マッチなし + L2 で hasLogo=true ならマッチ追加', async () => {
    const fakeClient: ClaudeVisionClient = {
      messages: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async create(..._args: any[]) {
          return {
            content: [
              {
                type: 'text',
                text: '{"has_logo": true, "evidence": "右下にロゴ"}',
              },
            ],
          }
        },
      } as unknown as ClaudeVisionClient['messages'],
    }
    const r = await detectCommercialLogos({
      textSources: ['普通の議事録テキスト'],
      pageImages: [new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
      claudeClient: fakeClient,
    })
    expect(r.needsUserConfirmation).toBe(true)
    expect(r.matches).toHaveLength(1)
    expect(r.matches[0].reason).toBe('claude_vision_confirmation')
    expect(r.matches[0].logo.id).toBe('unknown_vision_match')
  })

  it('L1 + L2 両方マッチなし → needsUserConfirmation=false', async () => {
    const fakeClient: ClaudeVisionClient = {
      messages: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async create(..._args: any[]) {
          return {
            content: [{ type: 'text', text: '{"has_logo": false}' }],
          }
        },
      } as unknown as ClaudeVisionClient['messages'],
    }
    const r = await detectCommercialLogos({
      textSources: ['普通の議事録テキスト'],
      pageImages: [new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
      claudeClient: fakeClient,
    })
    expect(r.needsUserConfirmation).toBe(false)
    expect(r.matches).toEqual([])
  })

  it('skipClaudeVision=true なら L2 を呼ばない', async () => {
    let visionCalled = false
    const fakeClient: ClaudeVisionClient = {
      messages: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async create(..._args: any[]) {
          visionCalled = true
          return { content: [{ type: 'text', text: '{"has_logo": true}' }] }
        },
      } as unknown as ClaudeVisionClient['messages'],
    }
    const r = await detectCommercialLogos({
      textSources: ['普通テキスト'],
      pageImages: [new Uint8Array([0x89])],
      skipClaudeVision: true,
      claudeClient: fakeClient,
    })
    expect(visionCalled).toBe(false)
    expect(r.matches).toEqual([])
  })

  it('Claude Vision がエラーを投げても fail-open（matches は L1 のみ）', async () => {
    const fakeClient: ClaudeVisionClient = {
      messages: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async create(..._args: any[]) {
          throw new Error('Anthropic API error')
        },
      } as unknown as ClaudeVisionClient['messages'],
    }
    const r = await detectCommercialLogos({
      textSources: ['普通テキスト'],
      pageImages: [new Uint8Array([0x89])],
      claudeClient: fakeClient,
    })
    // L1 マッチなし、L2 エラー → ユーザー詰まり回避で needsUserConfirmation=false
    expect(r.needsUserConfirmation).toBe(false)
    expect(r.matches).toEqual([])
  })
})
