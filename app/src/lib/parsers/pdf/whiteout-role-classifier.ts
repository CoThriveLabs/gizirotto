/**
 * WhiteoutRoleClassifier（白塗り v0.4、設計書 n6_layout_structure_draft_v0.4 §3）。
 *
 * 目的:
 *   LayoutCluster（行列マトリクス）+ markdownHint + tablesHtmlHint を Claude に渡し、
 *   各セルの「役割」を 4 値で判定させる。白塗り対象を confidence という脆い代理指標でなく
 *   レイアウト構造に基づく意味判定で決めることで、ラベル白塗り / 本文漏れの誤検出を断つ。
 *
 * role 4 値（設計 v0.4）:
 *   - 'label'           項目名ラベル（氏名 / 日時 等）→ 残す（塗らない）
 *   - 'value_or_entry'  記入された値 / 記入枠の文字 → ★白塗り対象（デフォルトこれのみ）
 *   - 'printed_static'  印刷された固定文言（会議タイトル / 定型注記 等）→ 残す
 *   - 'noise'           OCR ノイズ / 無意味断片 → 残す
 *
 * 座標非介入（§3-7 継承）:
 *   Claude には cellId と判定だけ返させ、bbox は前処理クラスタの実測値を使う
 *   （Claude Vision 座標誤差 ±10〜30px 問題を回避、±4px は OCR bbox 精度に依存）。
 *
 * 実装は field-semantic.ts の tool_use 強制 + cache_control パターンを踏襲。
 */

import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import type { LayoutCluster, LayoutCell } from './layout-cluster'
import {
  prefilterCells,
  PREFILTER_TEXT_TRUNCATE_LEN,
} from './whiteout-prefilter'

export type CellRole = 'label' | 'value_or_entry' | 'printed_static' | 'noise'

export interface CellClassification {
  cellId: string
  role: CellRole
  /** value_or_entry / label のとき、対応するフィールド名（snake_case 推奨、任意） */
  fieldName?: string
  /** 表示用ラベル（任意） */
  fieldLabel?: string
}

/**
 * field-semantic.ts と同じ最小クライアント interface。
 * Anthropic SDK 本体 / モック / 将来別実装を差し替え可能にする。
 */
export type RoleClassifierClient = {
  messages: {
    create: (...args: never[]) => Promise<{
      content: Array<{ type: string; [k: string]: unknown }>
    }>
  }
}

export interface ClassifyCellRolesInput {
  cluster: LayoutCluster
  /** 既存 scan の sourceMarkdown を連結したヒント（構造把握の補助） */
  markdownHint?: string
  /** 既存 collectTablesHtml 相当の table HTML 群（補助） */
  tablesHtmlHint?: string[]
}

export interface ClassifyCellRolesOptions {
  client?: RoleClassifierClient
  /**
   * role 判定 Claude 呼びの timeout（ms）。呼び出し側（route）が残予算を渡す。
   * 未指定なら ROLE_CLASSIFY_TIMEOUT_MS。渡された値も上限で clamp する。
   */
  timeoutMs?: number
}

const CLASSIFY_TOOL_NAME = 'classify_cell_roles'

/**
 * role 判定 Claude 呼びの timeout 既定/上限（ms）。preview の 60s 予算のうち、
 * tesseract+mistral+rasterize+upload を残して role 判定に割ける上限。
 * 超えたら SDK が例外 → route フォールバック。実機計測で要調整。
 */
const ROLE_CLASSIFY_TIMEOUT_MS = 25_000

const CellClassificationZ = z.object({
  cellId: z.string().min(1),
  role: z.enum(['label', 'value_or_entry', 'printed_static', 'noise']),
  fieldName: z.string().optional(),
  fieldLabel: z.string().optional(),
})

const ClassificationsResultZ = z.object({
  classifications: z.array(CellClassificationZ),
})

/** Anthropic tool 用 JSON Schema（手書きで完全制御、field-semantic と同パターン）。 */
const classifyToolJsonSchema = {
  type: 'object' as const,
  required: ['classifications'],
  additionalProperties: false,
  properties: {
    classifications: {
      type: 'array',
      items: {
        type: 'object',
        required: ['cellId', 'role'],
        additionalProperties: false,
        properties: {
          cellId: { type: 'string' },
          role: {
            type: 'string',
            enum: ['label', 'value_or_entry', 'printed_static', 'noise'],
          },
          fieldName: { type: 'string' },
          fieldLabel: { type: 'string' },
        },
      },
    },
  },
}

const SYSTEM_PROMPT = `あなたは日本語の議事録・帳票レイアウト解析の専門家です。
スキャンされた PDF から OCR で抽出され、行・列に整形された「セル」の一覧が与えられます。
各セルの役割を以下の 4 値のいずれかに分類してください。

- label: 項目名ラベル（例「氏名」「日時」「場所」「議題」）。記入欄の見出し。
- value_or_entry: 実際に記入された値、または記入枠に入っている文字。ユーザーが書き込んだ内容。
- printed_static: 印刷された固定文言（会議タイトル、定型の注記、ページ番号、フッター等）。
- noise: OCR ノイズや無意味な断片。

判断のヒント:
- isLeftmostInRow=true かつ labelLexiconHit=true のセルは label の可能性が高い。
- label の右隣（同じ行で colIndex が大きい）のセルは value_or_entry の可能性が高い。
- looksEmpty=true は記入枠（value_or_entry の空欄）の可能性。
- ページ上部に単独で大きく置かれた文言は printed_static（タイトル）の可能性。
- avgConfidence が低いだけで役割を決めない。必ずレイアウト構造（行・列・隣接関係）で判断する。

必ず与えられた全 cellId に対して 1 件ずつ分類を返してください。`

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY_MISSING')
  return new Anthropic({ apiKey })
}

/**
 * LayoutCluster の各セルを role 4 値に分類する。
 * cellId をキーに CellClassification[] を返す（bbox は呼び出し側が cluster 実測を使う）。
 */
export async function classifyCellRoles(
  input: ClassifyCellRolesInput,
  options: ClassifyCellRolesOptions = {},
): Promise<CellClassification[]> {
  const allCells = input.cluster.pages.flatMap(p => p.cells)
  if (allCells.length === 0) return []

  // 白塗り v0.5.1 §2 §4: ローカルルール R1〜R5 で事前に絞り込み、
  // remaining のみ Claude へ送る。confirmed は Claude を経由せず直接マージする。
  const { confirmed, remaining } = prefilterCells(allCells)

  // 全 cell がローカル確定したら Claude を呼ばずに返す（追加コスト 0）。
  if (remaining.length === 0) {
    return confirmed
  }

  const client = options.client ?? (getClient() as unknown as RoleClassifierClient)
  const model = process.env.ANTHROPIC_MODEL
  if (!model) throw new Error('ANTHROPIC_MODEL_MISSING')

  const userPrompt = buildUserPrompt(input, remaining)

  const params = {
    model,
    // 修正2 (CRITICAL): max_tokens を 8192 に引き上げ。セル数が多い議事録で classifications が
    // 4096 トークンに収まらず途中で切れる（stop_reason='max_tokens'）と zod parse が失敗し
    // preview 全体が落ちるため。下で stop_reason も検知して明示エラーにする。
    max_tokens: 8192,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    tools: [
      {
        name: CLASSIFY_TOOL_NAME,
        description:
          'Classify each layout cell into label / value_or_entry / printed_static / noise for whiteout targeting.',
        input_schema: classifyToolJsonSchema,
      },
    ],
    tool_choice: { type: 'tool', name: CLASSIFY_TOOL_NAME },
    messages: [{ role: 'user', content: userPrompt }],
  }

  // 修正1 (CRITICAL): timeout 注入（動的残予算化）。preview 経路は tesseract+mistral で
  // 既に重く 60s 予算と戦っている。OCR が長引くと「OCR + 固定25s > 60s」で SDK timeout 発火前に
  // Vercel が関数 kill → catch に入らず 504（N-13 再発）になる。そこで route が残予算を
  // options.timeoutMs で渡し、ここでは「指定値 or 既定25s」を 25s 上限で clamp して使う。
  // timeout 時は SDK が例外を投げ、route 側 catch で旧サジェストにフォールバックする。
  const effectiveTimeoutMs = Math.min(
    options.timeoutMs ?? ROLE_CLASSIFY_TIMEOUT_MS,
    ROLE_CLASSIFY_TIMEOUT_MS,
  )
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response = await (client.messages.create as any)(params, {
    timeout: effectiveTimeoutMs,
  })

  // 修正2 (CRITICAL): max_tokens 打ち切り検知。切れた応答は tool_use JSON が不完全で
  // zod parse が落ちるため、明示エラーにして route フォールバックへ回す（黙って劣化させない）。
  if (response.stop_reason === 'max_tokens') {
    throw new Error('ROLE_CLASSIFY_MAX_TOKENS_TRUNCATED')
  }

  const toolUse = (
    response.content as Array<{ type: string; name?: string; input?: unknown }>
  ).find(c => c.type === 'tool_use' && c.name === CLASSIFY_TOOL_NAME)
  if (!toolUse) throw new Error('NO_TOOL_USE_BLOCK')

  const parsed = ClassificationsResultZ.parse(toolUse.input)
  // 既知の cellId のみ採用（Claude が幻覚 cellId を返しても無害にする）。
  // 白塗り v0.5.1 §2 / §4: Claude には remaining のみ送っているが、安全側として
  // confirmed の cellId も含めた全 cellId 集合で knownIds を構築する（Claude が
  // confirmed の cellId を返してしまっても confirmed 優先で上書きされる）。
  const knownIds = new Set(allCells.map(c => c.cellId))
  const claudeResults = parsed.classifications.filter(c => knownIds.has(c.cellId))

  // 白塗り v0.5.1 §2 / §4: confirmed 優先マージ。cellId 重複時は confirmed を採用。
  const confirmedIds = new Set(confirmed.map(c => c.cellId))
  const merged: CellClassification[] = [
    ...confirmed,
    ...claudeResults.filter(c => !confirmedIds.has(c.cellId)),
  ]
  return merged
}

function buildUserPrompt(
  input: ClassifyCellRolesInput,
  cells: LayoutCell[],
): string {
  // 白塗り v0.5.1 §2 / §5: text を PREFILTER_TEXT_TRUNCATE_LEN 字で先頭 truncate。
  // labelLexiconHit は元 cell.text 基準で cluster 内で計算済の値をそのまま渡すので、
  // truncate されても本文判定の精度は維持される（§5 緩和策）。
  // truncate された旨はプロンプトに明示しない（プロンプト膨張回避）。
  const cellsForClaude = cells.map(c => ({
    cellId: c.cellId,
    page: c.page,
    rowIndex: c.rowIndex,
    colIndex: c.colIndex,
    text: c.text.slice(0, PREFILTER_TEXT_TRUNCATE_LEN),
    isLeftmostInRow: c.isLeftmostInRow,
    looksEmpty: c.looksEmpty,
    labelLexiconHit: c.labelLexiconHit,
    avgConfidence: Number(c.avgConfidence.toFixed(2)),
  }))

  const parts: string[] = []
  parts.push('# レイアウトセル一覧（JSON）')
  parts.push('```json')
  // 修正3 (CRITICAL): compact JSON（インデント無し）でトークン削減。整形は不要で、
  // セル数が多い議事録ではインデント分のトークンが入出力コスト/レイテンシに効く。
  parts.push(JSON.stringify(cellsForClaude))
  parts.push('```')

  if (input.markdownHint && input.markdownHint.trim().length > 0) {
    parts.push('\n# 参考: OCR markdown（構造把握の補助）')
    parts.push(input.markdownHint.slice(0, 4000))
  }
  if (input.tablesHtmlHint && input.tablesHtmlHint.length > 0) {
    parts.push('\n# 参考: 表 HTML（補助）')
    parts.push(input.tablesHtmlHint.join('\n').slice(0, 4000))
  }

  parts.push(
    `\n上記すべての cellId について role を分類し、${CLASSIFY_TOOL_NAME} ツールで返してください。`,
  )
  return parts.join('\n')
}
