import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentOutputCollector } from '../pi/extensions/epic/agents.ts'

function append(collector: AgentOutputCollector, event: unknown): void {
  collector.append(Buffer.from(`${JSON.stringify(event)}\n`))
}

test('streaming usage is cumulative per message and terminal snapshots are not counted twice', () => {
  const collector = new AgentOutputCollector()
  const first = { role: 'assistant', content: [], usage: { input: 10, output: 5, totalTokens: 15 } }
  append(collector, { type: 'message_update', usage: { input: 10, output: 1, totalTokens: 11 } })
  append(collector, { type: 'message_update', usage: first.usage })
  assert.deepEqual(collector.snapshot().usage, { ...first.usage, incomplete: true })
  append(collector, { type: 'message_end', message: first })
  assert.deepEqual(collector.snapshot().usage, first.usage)
  const second = { role: 'assistant', content: [], usage: { input: 20, output: 3, totalTokens: 23 } }
  append(collector, { type: 'message_update', usage: second.usage })
  append(collector, { type: 'message_end', message: second })
  append(collector, { type: 'agent_end', messages: [first, second] })
  assert.deepEqual(collector.finish().usage, { input: 30, output: 8, totalTokens: 38 })
})

test('completed assistant usage survives interruption before agent_end', () => {
  const collector = new AgentOutputCollector()
  append(collector, { type: 'message_end', message: {
    role: 'assistant', content: [], usage: { totalTokens: 12 },
  } })
  append(collector, { type: 'message_update', usage: { totalTokens: 4 } })
  assert.deepEqual(collector.finish().usage, { totalTokens: 16, incomplete: true })
})

test('terminal-only usage and successive agent runs aggregate without duplicating message snapshots', () => {
  const collector = new AgentOutputCollector()
  append(collector, { type: 'agent_end', messages: [{ role: 'assistant', usage: { totalTokens: 12 } }] })
  const message = { role: 'assistant', content: [], usage: { totalTokens: 7 } }
  append(collector, { type: 'message_end', message })
  append(collector, { type: 'agent_end', messages: [message] })
  assert.deepEqual(collector.finish().usage, { totalTokens: 19 })
})
