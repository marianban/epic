import assert from 'node:assert/strict'
import * as path from 'node:path'
import test from 'node:test'
import { createEpicState } from '../pi/extensions/epic/state.ts'

test('new epic plans are stored inside their run directory', () => {
  const root = '/repo'
  const seed = createEpicState(root, 'Keep plans isolated', '2026-08-16T00:00:00.000Z', {
    maxScoutRounds: 3,
    maxRepairsPerItem: 2,
    maxAcceptancePlanRepairs: 2,
    maxTaskInfrastructureRetries: 1,
    taskVerificationTimeoutMs: 2,
  })

  assert.equal(
    seed.domain.planPath,
    path.join(root, '.pi', 'epics', 'runs', seed.domain.epicId, 'plan.md')
  )
})
