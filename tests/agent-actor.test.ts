import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { quoteProcessInvocation } from '../pi/extensions/epic/execution-sandbox.ts'
import { runAgentActor } from '../pi/extensions/epic/machines/actors.ts'
import { AgentRunFailure } from '../pi/extensions/epic/agent-run-failure.ts'

test('agent actor returns output and propagates child aborts without uncaught errors', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-actor-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const prompt = path.join(root, 'prompt.md')
  await fs.writeFile(prompt, 'Test reviewer')
  t.mock.method(SandboxManager, 'checkDependencies', () => ({ errors: [], warnings: [] }))
  t.mock.method(SandboxManager, 'initialize', async () => undefined)
  t.mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
  t.mock.method(SandboxManager, 'reset', async () => undefined)
  const wrap = t.mock.method(SandboxManager, 'wrapWithSandbox', async () =>
    quoteProcessInvocation(process.execPath, ['-e', `
      console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Reviewed'}]}}));
    `])
  )
  const input = {
    repositoryRoot: root,
    agentRunDirectory: root,
    role: 'reviewer' as const,
    prompt: 'Review',
    profile: { role: 'reviewer' as const, systemPromptPath: prompt, tools: [], readOnly: true },
    timeoutMs: 5000,
  }
  const result = await runAgentActor(input)
  assert.equal(result.exitCode, 0)
  assert.equal(result.output, 'Reviewed')

  wrap.mock.mockImplementation(async () =>
    quoteProcessInvocation(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
  )
  const controller = new AbortController()
  const reason = new Error('Task verification deadline exhausted.')
  await assert.rejects(
    runAgentActor({
      ...input,
      signal: controller.signal,
      onProgress: (message) => {
        if (message.startsWith('reviewer child started')) controller.abort(reason)
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.name, 'AbortError')
      assert.equal(error.cause, reason)
      return true
    }
  )
  // XState reports observer errors on a later timer turn.
  await delay(25)
})

for (const interruption of ['abort', 'timeout'] as const) {
  test(`${interruption} preserves collected usage and the diagnostic log in the failure`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-telemetry-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const prompt = path.join(root, 'prompt.md')
    await fs.writeFile(prompt, 'Test reviewer')
    t.mock.method(SandboxManager, 'checkDependencies', () => ({ errors: [], warnings: [] }))
    t.mock.method(SandboxManager, 'initialize', async () => undefined)
    t.mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
    t.mock.method(SandboxManager, 'reset', async () => undefined)
    t.mock.method(SandboxManager, 'wrapWithSandbox', async () =>
      quoteProcessInvocation(process.execPath, ['-e', `
        console.log(JSON.stringify({type:'message_end',message:{role:'assistant',provider:'openai',model:'measured-model',content:[],usage:{totalTokens:15}}}));
        setInterval(() => {}, 1000);
      `])
    )
    const controller = new AbortController()
    const reason = new Error('Stop review')
    await assert.rejects(runAgentActor({
      repositoryRoot: root,
      agentRunDirectory: root,
      role: 'reviewer',
      prompt: 'Review',
      profile: { role: 'reviewer', systemPromptPath: prompt, tools: [], readOnly: true },
      timeoutMs: interruption === 'timeout' ? 1_000 : 5_000,
      signal: controller.signal,
      onProgress: (message) => {
        if (interruption === 'abort' && message === 'reviewer started producing output.') controller.abort(reason)
      },
    }), (error: unknown) => {
      assert.ok(error instanceof AgentRunFailure)
      assert.deepEqual(error.telemetry.usage, { totalTokens: 15, incomplete: true })
      assert.equal(error.telemetry.provider, 'openai')
      assert.equal(error.telemetry.model, 'measured-model')
      assert.ok(error.telemetry.stdoutLogPath.endsWith('.stdout.log'))
      if (interruption === 'abort') {
        assert.equal(error.name, 'AbortError')
        assert.equal(error.cause, reason)
      } else {
        assert.match(error.message, /timed out/)
      }
      return true
    })
    await delay(25)
  })
}
