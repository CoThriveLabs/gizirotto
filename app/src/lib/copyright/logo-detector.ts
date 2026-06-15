/**
 * 商用ロゴ検出（設計書 v1.4.2 §9-3 / 仕様書 v1.6.1 §0-3.5 要件 4）。
 *
 * L1 キーワード突合 + L2 Claude Vision 確認のハイブリッド方式。
 * 検出結果は **警告データ** として返すのみで、本ファイルは UI 表示や
 * 「アップロード差し戻し」等の自動決定を行わない（C-9 厳守、§9-0）。
 *
 * 重要（§9-0 / 仕様書 §0-3.5 要件 4 v1.6.1）:
 *   - 検出後は必ず L3 UI でユーザーに「続ける / キャンセル」を選ばせる
 *   - 本ファイル内の関数名 / コメントに「自動拒否」「reject」「block」「auto-deny」を含めない
 *   - 誤検出時に正当ユーザーが詰まらないよう、警告は「あくまで参考」スタンス
 *
 * §3-9 PdfEditorWatermarkFilter（試用版透かし fields 除外）とは
 * 完全に別系統（§9-3a-1 参照）。本ファイルからは PdfEditorWatermarkFilter を呼ばない。
 */

import {
  KNOWN_COMMERCIAL_LOGOS,
  type KnownLogoEntry,
} from './known-logos'

/** 検出結果の 1 件 */
export interface LogoDetectionMatch {
  /** マッチした known logo entry */
  logo: KnownLogoEntry
  /** マッチ根拠 */
  reason: 'keyword_match' | 'claude_vision_confirmation'
  /** マッチ confidence（0-1）。L1 keyword は 1.0、L2 Claude は応答に基づく */
  confidence: number
  /** 一致したキーワード or Claude 応答の抜粋 */
  evidence: string
}

/** 検出結果全体 */
export interface LogoDetectionResult {
  /** L1 + L2 で検出されたマッチ群 */
  matches: LogoDetectionMatch[]
  /** L3 UI で警告を表示すべきか（matches.length > 0 と同義、明示化のため） */
  needsUserConfirmation: boolean
}

/**
 * L1 速攻チェック: テキスト / markdown 内に既知商用ロゴのキーワードが含まれるか
 * を keyword 突合で判定する。
 *
 * 入力ソースは Mistral OCR markdown (§3-5-f) や TextPdfExtractor の出力。
 *
 * @param textSources  検査対象のテキスト群（複数ページの markdown 等を連結 OK）
 */
export function detectLogosByKeyword(textSources: string[]): LogoDetectionMatch[] {
  const matches: LogoDetectionMatch[] = []
  const normalized = textSources.join('\n').toLowerCase()
  for (const logo of KNOWN_COMMERCIAL_LOGOS) {
    for (const hint of logo.keywordHints) {
      if (normalized.includes(hint.toLowerCase())) {
        matches.push({
          logo,
          reason: 'keyword_match',
          confidence: 1.0,
          evidence: hint,
        })
        break // 1 logo につき 1 マッチで十分
      }
    }
  }
  return matches
}

/**
 * Claude Vision クライアントの最小 interface（既存 structure-extractor.ts と同パターン）。
 */
export interface ClaudeVisionClient {
  messages: {
    create: (...args: never[]) => Promise<{
      content: Array<{ type: string; [k: string]: unknown }>
    }>
  }
}

export interface ClaudeVisionInput {
  /** PDF ページ画像（PNG/JPG bytes、@napi-rs/canvas 経由でラスタライズ済） */
  pageImagePngBytes: Uint8Array
  /** Claude が確認する観点を絞るためのキーワード hint（KNOWN_COMMERCIAL_LOGOS から） */
  keywordHints?: string[]
}

/**
 * L2 Claude Vision 確認: 画像中に商用ロゴ / 社印 / ウォーターマーク / キャラクター
 * が含まれているかを自然言語で確認する。
 *
 * 用途: L1 を補完（L1 が漏らした未知ロゴの拾い上げ）。
 *
 * 重要:
 *   本関数は「検出結果（true/false）+ 根拠抜粋」を返すのみ。
 *   検出後の動作（警告表示 / ユーザー確認）は呼び出し側 UI が担当。
 */
export async function confirmLogoByClaudeVision(
  input: ClaudeVisionInput,
  options: { client?: ClaudeVisionClient } = {},
): Promise<{ hasLogo: boolean; evidence: string }> {
  const client = options.client ?? (await getDefaultClaudeClient())
  const model = process.env.ANTHROPIC_MODEL
  if (!model) throw new Error('ANTHROPIC_MODEL_MISSING')

  const hintText
    = input.keywordHints && input.keywordHints.length > 0
      ? `参考ヒント（既知 商用ベンダー名）: ${input.keywordHints.join(', ')}`
      : ''

  const userPrompt = `\
このページ画像に、以下のいずれかが含まれていますか？

- 会社のロゴ
- 社印
- 有料テンプレート販売サイトのウォーターマーク
- 独自キャラクター / マスコット

${hintText}

JSON で {"has_logo": boolean, "evidence": "理由の短い説明（30 字以内）"} の形で答えてください。
`

  const base64 = Buffer.from(input.pageImagePngBytes).toString('base64')

  const params = {
    model,
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: base64 },
          },
          { type: 'text', text: userPrompt },
        ],
      },
    ],
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response = await (client.messages.create as any)(params)

  // text ブロックから JSON を抽出（Claude は ``` ```で囲む場合あり）
  const textBlock = (
    response.content as Array<{ type: string; text?: string }>
  ).find(c => c.type === 'text' && typeof c.text === 'string')
  if (!textBlock || !textBlock.text) {
    return { hasLogo: false, evidence: 'no text response from Claude' }
  }

  const jsonMatch = textBlock.text.match(/\{[\s\S]*?\}/)
  if (!jsonMatch) {
    return { hasLogo: false, evidence: textBlock.text.slice(0, 100) }
  }
  try {
    const parsed = JSON.parse(jsonMatch[0])
    return {
      hasLogo: Boolean(parsed.has_logo),
      evidence: typeof parsed.evidence === 'string' ? parsed.evidence : '',
    }
  } catch {
    return { hasLogo: false, evidence: 'JSON parse failed' }
  }
}

/**
 * L1 + L2 統合: テキスト keyword + 画像 Vision で商用ロゴ検出。
 *
 * @returns LogoDetectionResult（matches + needsUserConfirmation）
 *          needsUserConfirmation=true なら呼び出し側 UI で L3 警告を表示し、
 *          ユーザーに「続ける / キャンセル」を選ばせる（C-9 厳守）。
 */
export async function detectCommercialLogos(input: {
  /** Mistral OCR markdown / pdfjs text 等の連結（L1 入力） */
  textSources: string[]
  /** 各ページの PNG bytes（L2 Claude Vision 入力、L1 でマッチなければスキップ可） */
  pageImages?: Uint8Array[]
  /** L2 をスキップしたい場合（テスト / コスト削減）*/
  skipClaudeVision?: boolean
  /** Claude client 注入（テスト用） */
  claudeClient?: ClaudeVisionClient
}): Promise<LogoDetectionResult> {
  // L1: keyword 突合
  const keywordMatches = detectLogosByKeyword(input.textSources)

  // L2: Claude Vision（必要時のみ）
  const visionMatches: LogoDetectionMatch[] = []
  if (
    !input.skipClaudeVision
    && input.pageImages
    && input.pageImages.length > 0
    && keywordMatches.length === 0
  ) {
    // L1 でマッチが無い時のみ L2 を呼ぶ（既知ロゴが見つかっていれば L2 重複不要、コスト削減）
    const allHints = KNOWN_COMMERCIAL_LOGOS.flatMap(l => l.keywordHints).slice(0, 20)
    // 1 ページ目のみ（複数ページは Phase 3 で必要なら拡張）
    const firstImage = input.pageImages[0]
    try {
      const vision = await confirmLogoByClaudeVision(
        { pageImagePngBytes: firstImage, keywordHints: allHints },
        { client: input.claudeClient },
      )
      if (vision.hasLogo) {
        // どの logo にも紐付かない時用に「unknown」エントリでマッチ作成
        visionMatches.push({
          logo: {
            id: 'unknown_vision_match',
            vendor: '不明（Claude Vision 検出）',
            category: 'paid_template_marketplace',
            warningLabel: 'ロゴ / 社印 / 商用ウォーターマークの可能性',
            sourceUrl: '',
            keywordHints: [],
          },
          reason: 'claude_vision_confirmation',
          confidence: 0.7, // Claude 応答の信頼度想定
          evidence: vision.evidence,
        })
      }
    } catch {
      // Claude Vision 失敗時は L1 のみで判定（fail-open、ユーザー詰まり回避）
    }
  }

  const matches = [...keywordMatches, ...visionMatches]
  return {
    matches,
    needsUserConfirmation: matches.length > 0,
  }
}

// ---------------------------------------------------------------------------
// 内部: default Anthropic client（structure-extractor.ts と同パターン）
// ---------------------------------------------------------------------------

let _defaultClient: ClaudeVisionClient | null = null

async function getDefaultClaudeClient(): Promise<ClaudeVisionClient> {
  if (_defaultClient) return _defaultClient
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY_MISSING')
  _defaultClient = new Anthropic({ apiKey }) as unknown as ClaudeVisionClient
  return _defaultClient
}
