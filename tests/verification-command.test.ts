import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { verifyCommand } from '../pi/extensions/epic/verification-command.ts'
import { quoteProcessInvocation } from '../pi/extensions/epic/execution-sandbox.ts'
import type { VerificationOperation } from '../pi/extensions/epic/verification-types.ts'

test('acceptance assertions allow script references and arbitrary build output', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'verification-command-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
    })
  )
  const operation: VerificationOperation = {
    signal: new AbortController().signal,
    remainingMs: () => 5000,
  }
  const command = `node -e "const p=require('./package.json'); for (const s of ['dev','build','preview']) if(typeof p.scripts?.[s] !== 'string' || !p.scripts[s]) process.exit(1)"`
  const obligation = {
    id: 'scripts',
    criterionId: 'AC1',
    expected: 'All project scripts exist',
    method: 'static' as const,
    command,
  }
  const result = await verifyCommand(
    obligation,
    root,
    root,
    'attempt',
    1,
    operation,
    4096
  )
  assert.equal(result.outcome, 'pass')
  assert.equal(result.reproduction, command)
  const artifact = result.artifacts[0]
  assert.ok(artifact)
  assert.equal(JSON.parse(await fs.readFile(artifact, 'utf8')).exitCode, 0)
  const build = await verifyCommand(
    { ...obligation, command: "mkdir -p arbitrary/build-output && node -e \"const cp=require('child_process');cp.execFileSync('git',['--version']);require('fs').writeFileSync('arbitrary/build-output/result.txt','built')\"" },
    root, root, 'attempt', 1, operation, 4096
  )
  assert.equal(build.outcome, 'pass')
  assert.equal(await fs.readFile(path.join(root, 'arbitrary/build-output/result.txt'), 'utf8'), 'built')
  await assert.rejects(
    verifyCommand(
      { ...obligation, command: '   ' },
      root,
      root,
      'attempt',
      1,
      operation,
      4096
    ),
    /non-empty string/
  )

  await fs.mkdir(path.join(root, '.git'))
  await fs.mkdir(path.join(root, '.pi', 'epics'), { recursive: true })
  for (const protectedPath of ['.git/config', '.pi/epics/state.json', '.env']) {
    const denied = await verifyCommand(
      { ...obligation, command: quoteProcessInvocation(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(protectedPath)}, 'forbidden')`]) },
      root, root, 'attempt', 1, operation, 4096
    )
    assert.equal(denied.outcome, 'fail', protectedPath)
    await assert.rejects(fs.access(path.join(root, protectedPath)))
  }

  // Use a sibling outside temporary directories, which are intentionally writable.
  const outside = await fs.mkdtemp(path.join(process.cwd(), '.sandbox-boundary-'))
  t.after(() => fs.rm(outside, { recursive: true, force: true }))
  const sentinel = path.join(outside, 'keep.txt')
  await fs.writeFile(sentinel, 'preserved')
  const deletion = await verifyCommand(
    { ...obligation, command: quoteProcessInvocation(process.execPath, ['-e', `require('fs').unlinkSync(${JSON.stringify(sentinel)})`]) },
    root, root, 'attempt', 1, operation, 4096
  )
  assert.equal(deletion.outcome, 'fail')
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'preserved')

  t.mock.method(SandboxManager, 'wrapWithSandbox', async () => {
    throw new Error('Sandbox setup failed')
  })
  await assert.rejects(
    verifyCommand(
      { ...obligation, command: 'touch must-not-execute' },
      root, root, 'attempt', 1, operation, 4096
    ),
    /Sandbox setup failed/
  )
  await assert.rejects(fs.access(path.join(root, 'must-not-execute')))
})
