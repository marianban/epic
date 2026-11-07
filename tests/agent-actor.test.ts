import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { quoteProcessInvocation } from '../pi/extensions/epic/execution-sandbox.ts'
import { runAgentActor } from '../pi/extensions/epic/machines/actors.ts'

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
