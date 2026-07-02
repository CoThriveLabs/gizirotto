/**
 * `data: ` 区切り SSE ストリームを読み、delta イベントごとに onDelta を呼ぶ純粋パーサ。
 * fetch の Response.body に直結する副作用（reader.read）を持つが、状態は一切保持しない。
 * 呼出側が onDelta 内で自分の state/クロージャ変数を更新する。
 *
 * Gotcha: evt.type === 'error' 分岐は throw した直後の catch で握り潰される（意図的ではなく
 * 既存挙動の踏襲）。サーバは実際に { type: 'error', message } を送信し得るため、この分岐は
 * 到達するが呼出元には一切伝播しない。修正は別タスク（挙動不変のためここでは変えない）。
 */
export async function parseSseStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (text: string) => void,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''
    for (const block of blocks) {
      const line = block.startsWith('data: ') ? block.slice(6) : block
      if (!line.trim()) continue
      try {
        const evt = JSON.parse(line)
        if (evt.type === 'delta' && typeof evt.text === 'string') {
          onDelta(evt.text)
        } else if (evt.type === 'error') {
          throw new Error(evt.message ?? 'stream_error')
        }
      } catch {
        // 部分受信エラーは次フレームで回復（evt.type==='error' の throw もここで握り潰される。
        // 既存挙動の踏襲・修正は別タスク）。
      }
    }
  }
}
