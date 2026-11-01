import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { createAgentRunStdoutLog } from '../pi/extensions/epic/agent-runs.ts'

async function capture(chunks: Buffer[]): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'epic-agent-run-'))
  try {
    const log = createAgentRunStdoutLog(directory, 'scout')
    for (const chunk of chunks) log.append(chunk)
    log.close()
    return await fs.readFile(log.filePath, 'utf8')
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

test('agent run logs discard redundant protocol records and retain errors', async () => {
  const records = [
    { type: 'session', id: 'session-1' },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'noise' } },
    { type: 'message_update', errorMessage: 'stream failed' },
    { type: 'message_start', message: { role: 'system', content: 'duplicate' } },
    { type: 'message_start', message: { role: 'user', content: 'request' } },
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    { type: 'message_start', message: { role: 'toolResult', content: 'duplicate' } },
    { type: 'message_end', message: { role: 'assistant', content: 'answer' } },
    { type: 'message_end', message: { role: 'toolResult', content: 'duplicate' } },
    { type: 'tool_execution_start', toolCallId: 'call-1' },
    { type: 'tool_execution_update', toolCallId: 'call-1' },
    { type: 'tool_execution_update', toolCallId: 'call-1', result: { isError: true } },
    { type: 'tool_execution_end', toolCallId: 'call-1' },
    { type: 'turn_end', message: { role: 'assistant', content: 'duplicate' } },
    { type: 'agent_end', messages: [] },
    { type: 'agent_end', errorMessage: 'provider unavailable', messages: [] },
    { type: 'future_protocol_event', detail: 'retain unknown records' },
  ]
  const input = `${records.map((record) => JSON.stringify(record)).join('\n')}\nnot-json\n`

  const output = await capture([Buffer.from(input)])
  const expected = records.filter((_, index) =>
    [0, 2, 4, 5, 7, 9, 11, 12, 15, 16].includes(index)
  )
  assert.equal(
    output,
    `${expected.map((record) => JSON.stringify(record)).join('\n')}\nnot-json\n`
  )
})

test('agent run logs preserve retained bytes across chunk and UTF-8 boundaries', async () => {
  const retained = `${JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: 'done ✓' } })}\r\n`
  const dropped = `${JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '✓' } })}\n`
  const trailing = 'incomplete ✓'
  const input = Buffer.from(`${retained}${dropped}${trailing}`)
  const marker = input.indexOf(Buffer.from('✓')) + 1

  const output = await capture([
    input.subarray(0, 7),
    input.subarray(7, marker),
    input.subarray(marker, marker + 1),
    input.subarray(marker + 1),
  ])

  assert.equal(output, `${retained}${trailing}`)
})

test('agent diagnostics omit image payloads and retain evidence metadata', async () => {
  const { AgentOutputCollector } = await import('../pi/extensions/epic/agents.ts')
  const record = { type: 'tool_execution_end', result: {
    content: [{ type: 'text', text: 'Image evidence ID: frame-1' }, { type: 'image', mimeType: 'image/png', data: 'PRIVATE_BITMAP_PAYLOAD' }],
    details: { id: 'probe-1', images: [{ id: 'frame-1', path: '/artifacts/frame.png' }] },
  } }
  const line = `${JSON.stringify(record)}\n`
  const chunks = [Buffer.from(line.slice(0, 100)), Buffer.from(line.slice(100))]
  const output = await capture(chunks)
  assert.doesNotMatch(output, /PRIVATE_BITMAP_PAYLOAD/)
  assert.match(output, /frame-1/)
  assert.match(output, /frame.png/)
  const collector = new AgentOutputCollector()
  chunks.forEach(chunk => collector.append(chunk))
  assert.doesNotMatch(collector.finish().diagnosticTail, /PRIVATE_BITMAP_PAYLOAD/)
})
