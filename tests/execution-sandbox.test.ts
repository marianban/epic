import assert from 'node:assert/strict'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import test from 'node:test'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { canonicalTemporaryPaths, wrapSandboxedInvocation } from '../pi/extensions/epic/execution-sandbox.ts'

test('execution sandbox allows canonical temporary directory aliases', () => {
  const paths = canonicalTemporaryPaths()

  assert.ok(paths.includes(path.resolve(os.tmpdir())))
  assert.ok(paths.includes('/tmp'))
  assert.ok(paths.includes('/var/tmp'))

  if (process.platform === 'darwin') {
    assert.ok(paths.includes('/private/tmp'))
    assert.ok(paths.includes('/private/var/tmp'))
  }
})

test('missing sandbox dependencies reject execution before initialization or wrapping', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-dependencies-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  t.mock.method(SandboxManager, 'checkDependencies', () => ({
    errors: ['Required executable missing'], warnings: [],
  }))
  const initialize = t.mock.method(SandboxManager, 'initialize', async () => undefined)
  const wrap = t.mock.method(SandboxManager, 'wrapWithSandbox', async () => 'must not run')
  await assert.rejects(
    wrapSandboxedInvocation(root, 'node', ['--version'], undefined),
    /Required executable missing/
  )
  assert.equal(initialize.mock.callCount(), 0)
  assert.equal(wrap.mock.callCount(), 0)
})
