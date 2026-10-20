import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { verifyCommand } from '../pi/extensions/epic/verification-command.ts'
import type { VerificationOperation } from '../pi/extensions/epic/verification-types.ts'

test('acceptance assertions may reference dev scripts while installation remains blocked', async (t) => {
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
  await assert.rejects(
    verifyCommand(
      { ...obligation, command: 'npm install' },
      root,
      root,
      'attempt',
      1,
      operation,
      4096
    ),
    /non-empty read-only check/
  )
})
