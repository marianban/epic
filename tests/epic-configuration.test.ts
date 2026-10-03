import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { resolveEpicConfiguration } from '../pi/extensions/epic/configuration.ts'

test('configuration resolves documented defaults once at the composition boundary', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'epic-config-'))
  try {
    assert.deepEqual(await resolveEpicConfiguration(root), {
      inspector: { enabled: false, port: 8080, autoOpen: true },
      agentTimeoutMs: 300_000,
      commandTimeoutMs: 120_000,
      maxOutputBytes: 20_000,
      maxScoutRounds: 3,
      maxFastRepairs: 2,
      maxFullRepairs: 1,
      maxSemanticRepairs: 2,
      maxTaskPlanRepairs: 2,
      checks: {
        browserSmoke: {
          startupTimeoutMs: 30_000,
          navigationTimeoutMs: 15_000,
          selectorTimeoutMs: 10_000,
          settleTimeoutMs: 500,
        },
      },
      agents: {},
    })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('configuration rejects malformed JSON and non-positive operational values', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'epic-config-'))
  const configPath = path.join(root, '.pi', 'epic.config.json')
  try {
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, '{')
    await assert.rejects(resolveEpicConfiguration(root), /Invalid epic configuration at/)
    await fs.writeFile(configPath, JSON.stringify({ agentTimeoutMs: 0 }))
    await assert.rejects(resolveEpicConfiguration(root), /agentTimeoutMs/)
    await fs.writeFile(configPath, JSON.stringify({ checks: { fast: [1] } }))
    await assert.rejects(resolveEpicConfiguration(root), /checks.fast/)
    await fs.writeFile(configPath, JSON.stringify({ maxTaskPlanRepairs: 0 }))
    await assert.rejects(resolveEpicConfiguration(root), /maxTaskPlanRepairs/)
    await fs.writeFile(
      configPath,
      JSON.stringify({ checks: { browserSmoke: { startupTimeoutMs: 0 } } })
    )
    await assert.rejects(
      resolveEpicConfiguration(root),
      /checks.browserSmoke.startupTimeoutMs/
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
