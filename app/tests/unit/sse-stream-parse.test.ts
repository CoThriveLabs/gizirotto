import { describe, it, expect, vi } from 'vitest'
import { parseSseStream } from '@/lib/utils/sse-stream'

/** Builds a ReadableStream that emits the given raw chunks in order (one chunk per pull). */
function makeSseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let idx = 0
  return new ReadableStream({
    pull(controller) {
      if (idx < chunks.length) {
        controller.enqueue(encoder.encode(chunks[idx++]))
      } else {
        controller.close()
      }
    },
  })
}

describe('parseSseStream', () => {
  it('delivers multiple delta events in order, including across split chunks', async () => {
    const stream = makeSseStream([
      'data: {"type":"delta","text":"foo"}\n\ndata: {"type":"delta","te',
      'xt":"bar"}\n\ndata: {"type":"delta","text":"baz"}\n\n',
    ])
    const received: string[] = []
    await parseSseStream(stream, (text) => received.push(text))
    expect(received).toEqual(['foo', 'bar', 'baz'])
  })

  it('ignores blank lines and lines without a data: prefix', async () => {
    const stream = makeSseStream([
      '\n\n',
      'not-a-data-line\n\n',
      'data: {"type":"delta","text":"ok"}\n\n',
    ])
    const received: string[] = []
    await parseSseStream(stream, (text) => received.push(text))
    expect(received).toEqual(['ok'])
  })

  it('ignores malformed JSON from a partial receive and recovers on the next chunk', async () => {
    // First block is invalid JSON (simulating a partial receive that never gets completed
    // as its own block); subsequent block is valid and should still be delivered.
    const stream = makeSseStream([
      'data: {"type":"delta","text":\n\n',
      'data: {"type":"delta","text":"recovered"}\n\n',
    ])
    const received: string[] = []
    await parseSseStream(stream, (text) => received.push(text))
    expect(received).toEqual(['recovered'])
  })

  it('does not throw when an error event is received (dead-catch regression guard)', async () => {
    const stream = makeSseStream(['data: {"type":"error","message":"x"}\n\n'])
    const onDelta = vi.fn()
    await expect(parseSseStream(stream, onDelta)).resolves.toBeUndefined()
    expect(onDelta).not.toHaveBeenCalled()
  })

  it('ignores event types other than delta or error', async () => {
    const stream = makeSseStream([
      'data: {"type":"done"}\n\n',
      'data: {"type":"delta","text":"after-done"}\n\n',
    ])
    const received: string[] = []
    await parseSseStream(stream, (text) => received.push(text))
    expect(received).toEqual(['after-done'])
  })
})
