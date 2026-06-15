import Anthropic from '@anthropic-ai/sdk'
import type { IntermediateFormat } from '../parsers/types'
import {
  TemplateSchemaZ,
  templateExtractionJsonSchema,
  type TemplateSchema,
} from './schemas/template-schema'
import { SYSTEM_PROMPT_TEMPLATE_EXTRACTION } from './prompts/template-extraction'

const EXTRACTION_TOOL_NAME = 'extract_template_structure'

/**
 * 構造抽出用の最小クライアント interface。
 * Anthropic SDK 本体 / モック / 将来別実装 を差し替え可能にする。
 */
export type StructureExtractorClient = {
  messages: {
    create: (...args: never[]) => Promise<{
      content: Array<{ type: string; [k: string]: unknown }>
    }>
  }
}

let _client: Anthropic | null = null

function getClient(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY_MISSING')
    _client = new Anthropic({ apiKey })
  }
  return _client
}

function buildUserContent(intermediate: IntermediateFormat): string {
  switch (intermediate.kind) {
    case 'html':
      return `テンプレ HTML:\n\n${intermediate.html}`
    case 'text':
      return `テンプレ抽出テキスト:\n\n${intermediate.text}`
    case 'sheets':
      return `テンプレ構造（Sheets）:\n\n${JSON.stringify(intermediate, null, 2)}`
  }
}

/**
 * テンプレ中間形式 → TemplateSchema 抽出。
 *
 * Anthropic SDK v0.32 系には公式 `response_format: json_schema` 機能がまだ無いため、
 * **tool_use を強制する** 方式で JSON Schema 準拠の応答を保証する（cache_control も付与）。
 */
export async function extractTemplateStructure(
  intermediate: IntermediateFormat,
  opts: { client?: StructureExtractorClient } = {},
): Promise<TemplateSchema> {
  const client = opts.client ?? (getClient() as unknown as StructureExtractorClient)
  const model = process.env.ANTHROPIC_MODEL
  if (!model) throw new Error('ANTHROPIC_MODEL_MISSING')

  // SDK v0.32 系の TextBlockParam 型には cache_control が宣言されていないが、
  // 実 API（2024-08 以降の prompt caching ベータ）では受理される。
  // 型エラー回避のため any 化した params を組み立てる。
  const params = {
    model,
    max_tokens: 2048,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT_TEMPLATE_EXTRACTION,
        cache_control: { type: 'ephemeral' },
      },
    ],
    tools: [
      {
        name: EXTRACTION_TOOL_NAME,
        description:
          'Extract structured template fields from family meeting minutes template.',
        input_schema: templateExtractionJsonSchema,
      },
    ],
    tool_choice: { type: 'tool', name: EXTRACTION_TOOL_NAME },
    messages: [{ role: 'user', content: buildUserContent(intermediate) }],
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response = await (client.messages.create as any)(params)

  const toolUse = (response.content as Array<{ type: string; name?: string; input?: unknown }>).find(
    (c) => c.type === 'tool_use' && c.name === EXTRACTION_TOOL_NAME,
  )
  if (!toolUse) throw new Error('NO_TOOL_USE_BLOCK')

  return TemplateSchemaZ.parse(toolUse.input)
}
