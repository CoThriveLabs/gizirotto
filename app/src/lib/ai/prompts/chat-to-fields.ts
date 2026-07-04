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
6. 会話で会議の開催日が絶対日付（例: 7月15日）として明示された場合のみ meeting_date に YYYY-MM-DD で格納する。「今日」「来週」などの相対表現や未言及時は meeting_date を出力しない（勝手に今日の日付で埋めない）

【出力スキーマ】
{ values: { [field_name]: string } } 形式。fields の name をキーに、対応する値を文字列で格納。
meeting_date は開催日が絶対日付で明示された場合のみ任意で追加。`

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
      meeting_date: {
        type: 'string',
        description:
          '会話中で会議の開催日（会議が実際に行われた日）が具体的な日付として明示されている場合のみ YYYY-MM-DD 形式で格納する。' +
          '「今日」「来週の月曜」などの相対表現や、日付が言及されていない場合は、このフィールド自体を出力しない（勝手に今日の日付で埋めない）。',
      },
    },
    required: ['values'],
    additionalProperties: false,
  }
}

/**
 * tool_use レスポンスの meeting_date を検証して正規化する。
 * YYYY-MM-DD 形式かつ実在する日付のみ通す（2026-13-45 のような不正日付は弾く）。
 * 妥当なら文字列、それ以外（未指定 / 相対表現 / 不正日付）は undefined を返す。
 * ゲスト route / ログイン Server Action の両方から呼び、抽出ロジックを 1 箇所に集約する。
 */
export function normalizeMeetingDate(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined
  // 実在日付チェック: Date に通して round-trip が一致するかで 2026-13-45 等を弾く。
  const d = new Date(`${raw}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return undefined
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}` === raw ? raw : undefined
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
