/**
 * 会話→JSON 変換 prompt（spec §6-5 v1.2 を Phase 5b 前倒し）。
 *
 * A-1 / A-2 チャット完了時、会話履歴 + fields 定義から各 field name にバインドした
 * JSON を生成する。tool_use 強制で JSON Schema 準拠の構造化応答を確実に取得。
 *
 * 失敗時の fallback は呼出側 (ChatView) で「最初の field に memo 詰め」に退避。
 */

export const SYSTEM_PROMPT_CHAT_TO_FIELDS = `あなたは家族議事録の会話履歴から項目別 JSON を構築するエージェントです。

【ルール】
1. 入力された会話履歴とテンプレ項目定義を読み、各項目に該当する情報を会話から抽出する
2. 該当情報がない項目は空文字列 "" で出力する（null や undefined ではなく空文字列）
3. 事実改変 / 創作禁止 = 会話に出てきた内容のみを使う、補完しない
4. 配列項目 (multiline / list 系) は改行区切りの 1 つの文字列にまとめる
5. 出力は tool_use 経由の構造化 JSON のみ。前置きや解説は不要

【出力スキーマ】
{ values: { [field_name]: string } } 形式。fields の name をキーに、対応する値を文字列で格納。`

/**
 * 入力 fields に基づく動的 JSON Schema 生成（tool_use 入力スキーマ用）。
 * 各 field name を properties キーにして string 型を設定、全項目 required（空文字許容）。
 */
export function buildChatToFieldsJsonSchema(args: {
  fields: Array<{ name: string; label: string }>
}): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  for (const f of args.fields) {
    properties[f.name] = {
      type: 'string',
      description: `${f.label} に該当する内容（該当なしは空文字列）`,
    }
  }
  return {
    type: 'object',
    properties: {
      values: {
        type: 'object',
        properties,
        required: args.fields.map((f) => f.name),
        additionalProperties: false,
      },
    },
    required: ['values'],
    additionalProperties: false,
  }
}

export function buildChatToFieldsUserPrompt(args: {
  fields: Array<{ name: string; label: string }>
  conversation: Array<{ role: 'user' | 'assistant'; content: string }>
}): string {
  const fieldList = args.fields
    .map((f, i) => `${i + 1}. ${f.name}（${f.label}）`)
    .join('\n')
  const conv = args.conversation
    .map((m) => `[${m.role === 'user' ? 'ユーザー' : 'AI'}] ${m.content}`)
    .join('\n')
  return `【テンプレ項目定義】
${fieldList}

【会話履歴】
${conv}

上記の会話履歴から、各項目に該当する内容を抽出して JSON で出力してください。`
}
