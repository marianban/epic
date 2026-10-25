import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createActor } from 'xstate'
import { createEpicMachine } from '../pi/extensions/epic/machines/epic-machine.ts'
import {
  appendEvent,
  loadEpicEvents,
  saveState,
} from '../pi/extensions/epic/persistence.ts'
import { loadActiveDashboardState } from '../pi/extensions/epic/dashboard/data.ts'
import type { EpicDomainState } from '../pi/extensions/epic/types.ts'
import type { EpicServices } from '../pi/extensions/epic/services.ts'
test('dashboard reads stage from the persisted actor snapshot', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'epic-dashboard-'))
  const domain: EpicDomainState = {
    epicId: 'run',
    epic: 'Test',
    repositoryRoot: root,
    epicComplexity: 'simple',
    scoutRound: 0,
    maxScoutRounds: 1,
    planPath: path.join(root, '.pi', 'epics', 'runs', 'run', 'plan.md'),
    planRevision: 0,
    planApproved: false,
    currentTaskIndex: 0,
    taskApproved: false,
    implementationAttempt: 0,
    maxTaskRepairs: 1,
    maxAcceptancePlanRepairs: 2,
    maxTaskInfrastructureRetries: 1,
    taskVerificationTimeoutMs: 1,
  }
  const unavailable = async (): Promise<never> => {
    throw new Error('not invoked')
  }
  const services: EpicServices = {
    ctx: {} as never,
    now: () => '2026-01-01T00:00:00.000Z',
    notify: () => undefined,
    classify: (s) => s,
    scout: unavailable,
    plan: unavailable,
    approvePlan: unavailable,
    reviewPlan: unavailable,
    decompose: unavailable,
    prerequisites: unavailable,
    preparePrerequisites: unavailable,
    prepareVerification: unavailable,
    verifyTask: unavailable,
    finalizeTask: unavailable,
    taskDecision: unavailable,
    implement: unavailable,
    serve: () => () => undefined,
    browserSmoke: unavailable,
    checks: unavailable,
    review: unavailable,
    reviseTask: unavailable,
    checkpointTask: unavailable,
    recordRecovery: unavailable,
    approveRecovery: unavailable,
  }
  const actor = createActor(createEpicMachine(services), {
    input: { state: domain },
  })
  actor.start()
  await saveState(domain, {
    schemaVersion: 9,
    machineVersion: 14,
    epicId: 'run',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    snapshot: actor.getPersistedSnapshot(),
  })
  await appendEvent(
    domain,
    'classifying',
    '2026-01-01T00:00:01.000Z',
    'agent_started',
    {
      invocationId: 'orphaned-agent',
      role: 'planner',
      action: 'planning',
    }
  )
  const dashboard = await loadActiveDashboardState(
    root,
    '2026-01-01T00:00:02.000Z'
  )
  assert.equal(dashboard?.epic.status, 'in-progress')
  assert.equal(dashboard?.epic.agentTimeMs, 1_000)
  const recovered = await loadActiveDashboardState(
    root,
    '2026-01-01T01:00:02.000Z'
  )
  assert.equal(recovered?.epic.agentTimeMs, 1_000)
  assert.equal(
    (await loadEpicEvents(domain)).filter(
      (event) => event.type === 'agent_finished'
    ).length,
    1
  )
  actor.stop()
  await fs.rm(root, { recursive: true, force: true })
})
