import { describe, it, expect, beforeEach } from 'vitest'
import {
  extractTemplateStructure,
  type StructureExtractorClient,
} from '@/lib/ai/structure-extractor'

/**
 * Anthropic SDK 呼び出しはモック化する。
 * tool_use ブロックを返すスタブクライアントを差し込み、TemplateSchema 検証のみを確認。
 */

function makeStubClient(toolInput: unknown): StructureExtractorClient {
  return {
    messages: {
      async create() {
        return {
          content: [
            {
              type: 'tool_use',
              name: 'extract_template_structure',
              input: toolInput,
            },
          ],
        }
      },
    },
  }
}

beforeEach(() => {
  process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-5-test'
  // API キーはモック経路で参照されないが、未設定だと getClient で落ちるためダミー
  process.env.ANTHROPIC_API_KEY = 'test-key'
})

describe('extractTemplateStructure', () => {
  it('parses valid tool_use input into TemplateSchema', async () => {
    const client = makeStubClient({
      title_position: 'top',
      fields: [
        { name: 'meeting_date', label: '日付', type: 'date', default: 'today', required: true },
        { name: 'attendees', label: '参加者', type: 'list', required: true },
      ],
    })
    const result = await extractTemplateStructure(
      { kind: 'html', html: '<h1>家族会議</h1>' },
      { client },
    )
    expect(result.title_position).toBe('top')
    expect(result.fields).toHaveLength(2)
    expect(result.fields[0].name).toBe('meeting_date')
    expect(result.fields[0].default).toBe('today')
  })

  it('throws when no tool_use block returned', async () => {
    const client: StructureExtractorClient = {
      messages: {
        async create() {
          return { content: [{ type: 'text', text: 'oops' }] }
        },
      },
    }
    await expect(
      extractTemplateStructure({ kind: 'text', text: 'foo' }, { client }),
    ).rejects.toThrow('NO_TOOL_USE_BLOCK')
  })

  it('throws zod error on schema violation (bad name)', async () => {
    const client = makeStubClient({
      title_position: 'top',
      fields: [{ name: 'Bad-Name!', label: 'foo', type: 'text', required: false }],
    })
    await expect(
      extractTemplateStructure({ kind: 'text', text: 'foo' }, { client }),
    ).rejects.toThrow()
  })

  it('rejects empty fields array', async () => {
    const client = makeStubClient({ title_position: 'top', fields: [] })
    await expect(
      extractTemplateStructure({ kind: 'text', text: 'foo' }, { client }),
    ).rejects.toThrow()
  })
})
