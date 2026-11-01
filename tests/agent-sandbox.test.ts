import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { CANONICAL_AGENT_ROLE_ORDER } from '../pi/extensions/epic/agent-profiles.ts'
import { runAgent } from '../pi/extensions/epic/agents.ts'
import { quoteProcessInvocation } from '../pi/extensions/epic/execution-sandbox.ts'

test('every agent role uses the sandbox and propagates sandbox failures', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sandbox-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const prompt = path.join(root, 'prompt.md')
  await fs.writeFile(prompt, 'Test agent')
  t.mock.method(SandboxManager, 'checkDependencies', () => ({ errors: [], warnings: [] }))
  t.mock.method(SandboxManager, 'initialize', async () => undefined)
  t.mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
  t.mock.method(SandboxManager, 'reset', async () => undefined)
  const wrap = t.mock.method(SandboxManager, 'wrapWithSandbox', async () =>
    quoteProcessInvocation(process.execPath, ['-e', `
      if (process.env.PI_EPIC_SANDBOX !== '1') process.exit(1);
      console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:process.env.PI_EPIC_ROLE}]}}));
    `])
  )
  for (const role of CANONICAL_AGENT_ROLE_ORDER) {
    const profile = { role, systemPromptPath: prompt, tools: [], readOnly: role !== 'implementer' }
    const options = { agentRunDirectory: root, timeoutMs: 5000 }
    const result = await runAgent(root, role, 'Test', options, profile)
    assert.equal(result.exitCode, 0, role)
    assert.equal(result.output, role)
  }
  assert.equal(wrap.mock.callCount(), CANONICAL_AGENT_ROLE_ORDER.length)
  wrap.mock.mockImplementation(async () => { throw new Error('Sandbox unavailable') })
  for (const role of CANONICAL_AGENT_ROLE_ORDER) {
    await assert.rejects(
      runAgent(root, role, 'Test', { agentRunDirectory: root, timeoutMs: 5000 },
        { role, systemPromptPath: prompt, tools: [], readOnly: role !== 'implementer' }),
      /Sandbox unavailable/
    )
  }
})
