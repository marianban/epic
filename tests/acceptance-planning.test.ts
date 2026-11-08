import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createActor, waitFor, type SnapshotFrom } from 'xstate'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import {
  AcceptancePlanningError,
  prepareAcceptancePlan,
  type AcceptancePlanningDependencies,
} from '../pi/extensions/epic/acceptance-planning.ts'
import {
  PlanValidationError,
  parseVerificationPlan,
  scenarioPlanningPrompt,
  validateVerificationPlan,
} from '../pi/extensions/epic/verification-plan.ts'
import { createEpicServices } from '../pi/extensions/epic/services.ts'
import { resolveEpicConfiguration } from '../pi/extensions/epic/configuration.ts'
import { createEpicState } from '../pi/extensions/epic/state.ts'
import {
  VerificationStore,
  taskVerificationPath,
} from '../pi/extensions/epic/verification-store.ts'
import {
  appendEvent,
  loadEpicEvents,
  parsePersistedEpicEnvelope,
  persistImmutableJsonArtifact,
} from '../pi/extensions/epic/persistence.ts'
import { createTaskExecutionMachine } from '../pi/extensions/epic/machines/task-execution-machine.ts'
import { createEpicMachine } from '../pi/extensions/epic/machines/epic-machine.ts'
import { projectActorSystemSnapshot } from '../pi/extensions/epic/machines/actor-system-projection.ts'
import { createEpicRuntime } from '../pi/extensions/epic/runtime.ts'
import { projectDashboardState } from '../pi/extensions/epic/dashboard/projection.ts'
import { formatEscalationMessage } from '../pi/extensions/epic/epic.ts'
import type { AgentRunResult } from '../pi/extensions/epic/agents.ts'
import type { EpicDomainState } from '../pi/extensions/epic/types.ts'
import type { VerificationPlan } from '../pi/extensions/epic/verification-types.ts'

const clock = {
  now: () => '2026-10-04T16:33:34.000Z',
  nowMs: () => Date.parse('2026-10-04T16:33:34.000Z'),
}
const timer = { setTimeout, clearTimeout }
const criteria = [{ id: 'task-1:AC1', text: 'Host container exists.' }]
function validPlan(): VerificationPlan {
  return {
    version: 1,
    criterionVersion: 1,
    criteria,
    obligations: [
      {
        id: 'task-1:AC1:O1',
        criterionId: criteria[0].id,
        expected: 'Host container exists.',
        method: 'agent_browser',
        steps: [
          {
            action: 'inspect',
            expression: "document.querySelector('#game-container') !== null",
          },
        ],
      },
    ],
  }
}
function malformedPlan(): string {
  const value = validPlan()
  return JSON.stringify({
    ...value,
    obligations: [
      {
        ...value.obligations[0],
        steps: [
          { inspect: "document.querySelector('#game-container') !== null" },
        ],
      },
    ],
  })
}
const ctx = {
  ui: { notify: () => undefined, setStatus: () => undefined },
} as unknown as ExtensionContext

async function fixture(
  t: TestContext,
  responses: (string | Error | Partial<AgentRunResult>)[]
) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'epic-acceptance-planning-')
  )
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const configuration = await resolveEpicConfiguration(root)
  const { domain: state, metadata } = createEpicState(
    root,
    'Build host',
    clock.now(),
    configuration
  )
  state.tasks = [
    {
      id: 'task-1',
      title: 'Build host',
      objective: 'Build host',
      files: { context: [], expectedChanges: ['index.html'] },
      implementation: ['Create host'],
      acceptanceCriteria: criteria.map((criterion) => criterion.text),
      verification: [],
      manualReviewSteps: ['Inspect host'],
      risks: [],
      requiredChecks: [],
      deferredChecks: [],
      reason: 'Host slice',
    },
  ]
  state.planApproved = true
  const store = new VerificationStore(taskVerificationPath(state), clock)
  const prompts: string[] = []
  const work = { implement: 0, verify: 0, finalize: 0 }
  const services = createEpicServices(
    ctx,
    () => ({ stage: 'planning_acceptance', wait: 'active' }),
    clock,
    configuration,
    {
      timer,
      runAgentActor: async (options) => {
        assert.equal(options.role, 'verification-planner')
        assert.equal(options.profile.systemPromptPath, '.pi/agents/verification-planner.md')
        assert.equal(options.bridge, undefined)
        prompts.push(options.prompt)
        const response = responses.shift()
        assert.notEqual(
          response,
          undefined,
          'Unexpected extra planner invocation'
        )
        if (response instanceof Error) throw response
        return {
          role: 'verification-planner',
          exitCode: 0,
          output: typeof response === 'string' ? response : '',
          stderr: '',
          stdoutLogPath: path.join(
            root,
            `verification-planner-${prompts.length}.stdout.log`
          ),
          ...(typeof response === 'object' ? response : {}),
        }
      },
    }
  )
  services.implement = async (current) => {
    work.implement++
    return {
      ...current,
      implementationAttempt: current.implementationAttempt + 1,
    }
  }
  services.verifyTask = async (current) => {
    work.verify++
    return { ...current, verificationReadiness: 'verified' }
  }
  services.finalizeTask = async () => {
    work.finalize++
    throw new Error('Unexpected review finalization')
  }
  const actor = createActor(createTaskExecutionMachine(services), {
    input: { domain: state },
  }).start()
  t.after(() => actor.stop())
  return {
    root,
    state,
    metadata,
    configuration,
    store,
    services,
    actor,
    prompts,
    work,
    responses,
  }
}

test('planner contract includes valid full-plan, method, and browser action examples', () => {
  const prompt = scenarioPlanningPrompt(criteria, 1, 1)
  const exampleLine = prompt
    .split('\n')
    .find((line) => line.startsWith('Complete example'))
  assert.ok(exampleLine)
  const example = parseVerificationPlan(
    exampleLine.slice(exampleLine.indexOf(': ') + 2)
  ) as VerificationPlan
  validateVerificationPlan(example, example.criteria, 1)
  const methodsLine = prompt
    .split('\n')
    .find((line) => line.startsWith('Method examples'))
  assert.ok(methodsLine)
  const methods = JSON.parse(
    methodsLine.slice(methodsLine.indexOf(': ') + 2)
  ) as VerificationPlan['obligations']
  for (const obligation of methods)
    validateVerificationPlan(
      { ...example, obligations: [obligation] },
      example.criteria,
      1
    )
  assert.match(prompt, /"action":"inspect","expression"/)
  assert.match(prompt, /ONE valid JSON object/)
})

test('the Arkanoid browser-step shape reports an exact field path and never normalizes it', () => {
  assert.throws(
    () =>
      validateVerificationPlan(
        parseVerificationPlan(malformedPlan()),
        criteria,
        1
      ),
    (error) => {
      assert.ok(error instanceof PlanValidationError)
      assert.deepEqual(
        error.issues.map(({ path, code }) => ({ path, code })),
        [{ path: 'obligations[0].steps[0].action', code: 'unknown_action' }]
      )
      assert.match(error.message, /received undefined/)
      return true
    }
  )
  for (const output of [
    JSON.stringify(validPlan()) + ']}',
    '```json\n' + JSON.stringify(validPlan()) + '\n```',
    '[]',
  ]) {
    assert.throws(
      () =>
        validateVerificationPlan(parseVerificationPlan(output), criteria, 1),
      PlanValidationError
    )
  }
})

test('first-attempt success freezes a plan before implementation without charging verification', async (t) => {
  const f = await fixture(t, [JSON.stringify(validPlan())])
  f.actor.send({ type: 'TASK.APPROVE' })
  await waitFor(f.actor, (snapshot) => snapshot.matches('awaitingReview'), {
    timeout: 2_000,
  })
  const record = await f.store.read()
  assert.deepEqual(record.plan, validPlan())
  assert.deepEqual(f.work, { implement: 1, verify: 1, finalize: 0 })
  assert.deepEqual(record.invocations, [])
  assert.equal(record.startedAt, undefined)
  assert.equal(record.deadline, undefined)
  const events = await loadEpicEvents(f.state)
  const accepted = events.find(
    (event) => event.type === 'acceptance_plan_accepted'
  )
  const finished = events.find((event) => event.type === 'agent_finished')
  assert.ok(accepted)
  assert.equal(accepted.payload.attempt, 1)
  assert.equal(accepted.payload.invocationId, finished?.payload.invocationId)
  assert.equal(accepted.payload.stdoutLogPath, finished?.payload.stdoutLogPath)
})

test('malformed steps and trailing JSON receive precise corrections within three calls', async (t) => {
  const f = await fixture(t, [
    malformedPlan(),
    JSON.stringify(validPlan()) + ']}',
    JSON.stringify(validPlan()),
  ])
  await f.services.prepareVerification(f.state)
  assert.equal(f.prompts.length, 3)
  assert.match(f.prompts[1], /obligations\[0\].steps\[0\].action/)
  assert.match(f.prompts[2], /invalid_json/)
  for (const prompt of f.prompts) assert.match(prompt, /Complete example/)
  const events = await loadEpicEvents(f.state)
  const planning = events.filter((event) =>
    event.type.startsWith('acceptance_plan_')
  )
  assert.equal(new Set(planning.map((event) => event.payload.batchId)).size, 1)
  assert.equal(
    events.filter((event) => event.type === 'acceptance_plan_attempt_rejected')
      .length,
    2
  )
  assert.deepEqual((await f.store.read()).invocations, [])
})

test('exhaustion pauses before implementation; explicit resume starts a fresh batch', async (t) => {
  const f = await fixture(t, [
    malformedPlan(),
    malformedPlan(),
    malformedPlan(),
    JSON.stringify(validPlan()),
  ])
  f.actor.send({ type: 'TASK.APPROVE' })
  await waitFor(
    f.actor,
    (snapshot) => snapshot.matches('acceptancePlanningFailed'),
    { timeout: 2_000 }
  )
  const failed = f.actor.getSnapshot()
  assert.equal(f.prompts.length, 3)
  assert.deepEqual(f.work, { implement: 0, verify: 0, finalize: 0 })
  assert.equal(failed.context.domain.taskApproved, true)
  assert.equal(failed.context.domain.implementationAttempt, 0)
  assert.equal(failed.context.domain.lastVerificationReportPath, undefined)
  assert.equal(failed.context.domain.verificationReadiness, undefined)
  assert.match(failed.context.failureReason ?? '', /after 3 attempt/)
  assert.equal(failed.can({ type: 'TASK.APPROVE' }), false)
  assert.equal(
    failed.can({ type: 'TASK.DECIDE', request: { kind: 'approve' } }),
    false
  )
  const record = await f.store.read()
  assert.deepEqual(record.invocations, [])
  assert.deepEqual(record.cycles, [])
  assert.equal(record.report, undefined)
  assert.equal(record.deadline, undefined)
  const approvedAt = failed.context.domain.taskApprovedAt
  f.actor.send({ type: 'EPIC.RESUME' })
  await waitFor(f.actor, (snapshot) => snapshot.matches('awaitingReview'), {
    timeout: 2_000,
  })
  assert.deepEqual(f.work, { implement: 1, verify: 1, finalize: 0 })
  assert.equal(f.actor.getSnapshot().context.domain.taskApprovedAt, approvedAt)
  assert.equal(f.actor.getSnapshot().context.failureReason, undefined)
  assert.equal(f.actor.getSnapshot().context.domain.failureReason, undefined)
  const started = (await loadEpicEvents(f.state)).filter(
    (event) => event.type === 'acceptance_plan_attempt_started'
  )
  assert.equal(new Set(started.map((event) => event.payload.batchId)).size, 2)
  assert.deepEqual(
    started.map((event) => event.payload.attempt),
    [1, 2, 3, 1]
  )
})

test('zero planning repairs allows exactly one call independently of infrastructure allowance', async (t) => {
  const f = await fixture(t, [malformedPlan()])
  f.state.maxAcceptancePlanRepairs = 0
  f.state.maxTaskInfrastructureRetries = 0
  await assert.rejects(f.services.prepareVerification(f.state), (error) => {
    assert.ok(error instanceof AcceptancePlanningError)
    assert.equal(error.attempts, 1)
    assert.equal(error.category, 'invalid_output')
    return true
  })
  assert.equal(f.prompts.length, 1)
  assert.deepEqual((await f.store.read()).invocations, [])
})

for (const response of [
  new Error('Agent timed out'),
  { exitCode: 1, failureReason: 'Provider unavailable' },
]) {
  test('invocation failures pause immediately without spending planning repairs', async (t) => {
    const f = await fixture(t, [response])
    f.actor.send({ type: 'TASK.APPROVE' })
    await waitFor(
      f.actor,
      (snapshot) => snapshot.matches('acceptancePlanningFailed'),
      { timeout: 2_000 }
    )
    assert.equal(f.prompts.length, 1)
    assert.deepEqual(f.work, { implement: 0, verify: 0, finalize: 0 })
    const failed = (await loadEpicEvents(f.state)).find(
      (event) => event.type === 'acceptance_plan_failed'
    )
    assert.equal(failed?.payload.category, 'invocation')
    assert.equal(failed?.payload.exhausted, false)
  })
}

test('storage and persisted-criteria errors are not retried', async (t) => {
  const f = await fixture(t, [JSON.stringify(validPlan())])
  await f.store.initialize(f.state)
  const deps: AcceptancePlanningDependencies = {
    clock,
    repairLimit: 2,
    initialize: () => f.store.read(),
    write: (record) => f.store.write(record),
    run: async () => {
      throw new Error('Unexpected invocation')
    },
    persistPlan: (plan) =>
      persistImmutableJsonArtifact(f.state, 'reviews/plan.json', plan),
    event: (type, timestamp, payload) =>
      appendEvent(f.state, 'planning_acceptance', timestamp, type, payload),
  }
  const task = f.state.tasks?.[0]
  assert.ok(task)
  const changed: EpicDomainState = {
    ...f.state,
    tasks: [{ ...task, acceptanceCriteria: ['Changed meaning'] }],
  }
  await assert.rejects(
    prepareAcceptancePlan(changed, deps),
    (error) =>
      error instanceof AcceptancePlanningError &&
      error.category === 'criteria' &&
      error.attempts === 0
  )
  await assert.rejects(
    prepareAcceptancePlan(f.state, {
      ...deps,
      initialize: async () => {
        throw new Error('Invalid ledger')
      },
    }),
    (error) =>
      error instanceof AcceptancePlanningError &&
      error.category === 'storage' &&
      error.attempts === 0
  )
  let calls = 0
  await assert.rejects(
    prepareAcceptancePlan(f.state, {
      ...deps,
      run: async () => {
        calls++
        return {
          role: 'verification-planner',
          exitCode: 0,
          output: JSON.stringify(validPlan()),
          stderr: '',
          stdoutLogPath: 'verification-planner.log',
        }
      },
      persistPlan: async () => {
        throw new Error('Disk full')
      },
    }),
    (error) =>
      error instanceof AcceptancePlanningError &&
      error.category === 'storage' &&
      error.attempts === 1
  )
  assert.equal(calls, 1)
})

test('replanning failure resumes to verification without repeating implementation', async (t) => {
  const f = await fixture(t, [
    JSON.stringify(validPlan()),
    malformedPlan(),
    malformedPlan(),
    malformedPlan(),
    JSON.stringify({ ...validPlan(), version: 2 }),
  ])
  f.services.taskDecision = async (state) => {
    const record = await f.store.read()
    delete record.plan
    await f.store.write(record)
    return {
      ...state,
      lastVerificationReportPath: undefined,
      verificationReadiness: undefined,
    }
  }
  f.actor.send({ type: 'TASK.APPROVE' })
  await waitFor(f.actor, (snapshot) => snapshot.matches('awaitingReview'), {
    timeout: 2_000,
  })
  f.actor.send({
    type: 'TASK.DECIDE',
    request: {
      kind: 'revise_criteria',
      criteria: [criteria[0].text],
      identity: 'revision',
      reportId: 'report',
      reason: 'Clarify criteria',
    },
  })
  await waitFor(
    f.actor,
    (snapshot) => snapshot.matches('acceptanceReplanningFailed'),
    { timeout: 2_000 }
  )
  assert.deepEqual(f.work, { implement: 1, verify: 1, finalize: 0 })
  f.actor.send({ type: 'EPIC.RESUME' })
  await waitFor(f.actor, (snapshot) => snapshot.matches('awaitingReview'), {
    timeout: 2_000,
  })
  assert.deepEqual(f.work, { implement: 1, verify: 2, finalize: 0 })
})

for (const failedState of [
  'acceptancePlanningFailed',
  'acceptanceReplanningFailed',
]) {
  test(`dashboard and command guidance describe ${failedState} without presenting review actions`, async (t) => {
    const f = await fixture(t, [])
    const state = {
      ...f.state,
      failureReason:
        'Acceptance planning failed after 3 attempt(s): invalid JSON',
    }
    const boundary = projectActorSystemSnapshot({
      value: 'taskExecution',
      children: {
        'task-execution': {
          snapshot: {
            value: failedState,
            context: {
              domain: state,
              failureReason: state.failureReason,
              repairs: { fast: 0, full: 0, semantic: 0 },
            },
          },
        },
      },
    })
    assert.equal(boundary.stage, 'acceptance_planning_failed')
    assert.equal(boundary.wait, 'awaiting-human')
    assert.equal(boundary.pendingHumanAction, 'retry_acceptance_planning')
    const dashboard = projectDashboardState({
      domain: state,
      metadata: f.metadata,
      boundary,
      events: [
        {
          id: 'old-report',
          epicId: state.epicId,
          timestamp: clock.now(),
          type: 'task_review_completed',
          stage: 'finalizing_report',
          payload: { taskId: 'task-1', criteriaCompleted: 2, criteriaTotal: 2 },
        },
      ],
      agentProfiles: [],
      now: clock.now(),
    })
    assert.equal(
      dashboard.currentTask?.criteria.completed,
      0,
      'Planning failure must not show stale criterion results'
    )
    if (failedState === 'acceptancePlanningFailed')
      assert.equal(dashboard.currentTask?.attempt.current, 0)
    assert.match(
      dashboard.actionRequired?.title ?? '',
      failedState === 'acceptanceReplanningFailed'
        ? /verification is paused/
        : /implementation has not started/
    )
    assert.match(dashboard.actionRequired?.message ?? '', /3 attempt/)
    assert.deepEqual(
      dashboard.actionRequired?.actions.map((action) => action.id),
      ['epic-resume', 'epic-exit']
    )
    assert.equal(dashboard.currentTask?.status, 'failed')
    assert.match(
      formatEscalationMessage({ domain: state, boundary }) ?? '',
      /epic-resume/
    )
  })
}

for (const planningState of [
  'planningAcceptance',
  'replanningAcceptance',
  'acceptancePlanningFailed',
  'acceptanceReplanningFailed',
]) {
  test(`reopening ${planningState} preserves planning recovery and creates no acceptance report`, async (t) => {
    const f = await fixture(t, [])
    const childSnapshot = {
      ...f.actor.getPersistedSnapshot(),
      value: planningState,
    }
    const parent = createActor(createEpicMachine(f.services), {
      input: { state: f.state },
    })
    const snapshot = {
      ...parent.getPersistedSnapshot(),
      value: 'taskExecution',
      children: {
        'task-execution': {
          src: 'task',
          snapshot: childSnapshot,
          syncSnapshot: false,
        },
      },
    }
    const record = await f.store.initialize(f.state)
    if (planningState === 'planningAcceptance') {
      record.plan = validPlan()
      record.plans.push({
        plan: validPlan(),
        artifact: await persistImmutableJsonArtifact(
          f.state,
          'reviews/saved-plan.json',
          validPlan()
        ),
      })
      await f.store.write(record)
    }
    await appendEvent(
      f.state,
      'planning_acceptance',
      clock.now(),
      'acceptance_plan_attempt_started',
      {
        taskId: 'task-1',
        batchId: 'interrupted-batch',
        attempt: 2,
        invocationId: 'invocation',
      }
    )
    const runtime = await createEpicRuntime(
      f.state,
      f.metadata,
      ctx,
      clock,
      timer,
      f.configuration,
      snapshot
    )
    t.after(() => runtime.stop())
    assert.equal(runtime.boundary().stage, 'acceptance_planning_failed')
    const expectedState =
      planningState.includes('Replanning') ||
      planningState === 'replanningAcceptance'
        ? 'acceptanceReplanningFailed'
        : 'acceptancePlanningFailed'
    assert.equal(runtime.boundary().task?.state, expectedState)
    assert.deepEqual((await f.store.read()).cycles, [])
    assert.equal((await f.store.read()).report, undefined)
    assert.equal(runtime.domain().verificationReadiness, undefined)
    assert.deepEqual(f.work, { implement: 0, verify: 0, finalize: 0 })
    const recovered = await createEpicRuntime(
      runtime.domain(),
      f.metadata,
      ctx,
      clock,
      timer,
      f.configuration,
      runtime.persistedSnapshot()
    )
    t.after(() => recovered.stop())
    assert.equal(recovered.boundary().task?.state, expectedState)
    assert.throws(
      () => recovered.dispatchAndSettle({ type: 'TASK.APPROVE' }, undefined),
      /not available in stage acceptance_planning_failed/
    )
    assert.throws(
      () =>
        recovered.dispatchAndSettle(
          { type: 'TASK.DECIDE', request: { kind: 'approve' } },
          undefined
        ),
      /not available in stage acceptance_planning_failed/
    )
    const failures = (await loadEpicEvents(f.state)).filter(
      (event) => event.type === 'acceptance_plan_failed'
    )
    assert.equal(failures.length, planningState.endsWith('Failed') ? 0 : 1)
    if (planningState === 'planningAcceptance') {
      const before = (await loadEpicEvents(f.state)).length
      await f.services.prepareVerification(runtime.domain())
      assert.equal((await loadEpicEvents(f.state)).length, before)
      assert.equal(f.prompts.length, 0, 'A saved valid plan must be reused')
    }
    const restored = recovered.persistedSnapshot() as unknown as {
      children: {
        'task-execution': {
          snapshot: SnapshotFrom<ReturnType<typeof createTaskExecutionMachine>>
        }
      }
    }
    f.responses.push(JSON.stringify(validPlan()))
    const resumed = createActor(createTaskExecutionMachine(f.services), {
      input: { domain: recovered.domain() },
      snapshot: restored.children['task-execution'].snapshot,
    }).start()
    t.after(() => resumed.stop())
    resumed.send({ type: 'EPIC.RESUME' })
    await waitFor(resumed, (snapshot) => snapshot.matches('awaitingReview'), {
      timeout: 2_000,
    })
    assert.equal(
      f.work.implement,
      expectedState === 'acceptancePlanningFailed' ? 1 : 0
    )
    assert.equal(f.work.verify, 1)
    assert.equal(f.work.finalize, 0)
    assert.equal(
      f.prompts.length,
      planningState === 'planningAcceptance' ? 0 : 1
    )
    assert.equal(resumed.getSnapshot().context.domain.failureReason, undefined)
  })
}

test('old 7/12 runs fail with an incompatibility diagnosis and no migration', async (t) => {
  const f = await fixture(t, [])
  assert.throws(
    () =>
      parsePersistedEpicEnvelope({
        schemaVersion: 7,
        machineVersion: 12,
        ...f.metadata,
        snapshot: {},
      }),
    /found schema\/machine version 7\/12.*Required schema\/machine version 13\/14; no compatibility migration was applied/
  )
})

test('planning repair configuration defaults to two and accepts zero, rejecting invalid limits', async (t) => {
  const f = await fixture(t, [])
  assert.equal(f.configuration.maxAcceptancePlanRepairs, 2)
  const file = path.join(f.root, '.pi', 'epic.config.json')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify({ maxAcceptancePlanRepairs: 0 }))
  assert.equal(
    (await resolveEpicConfiguration(f.root)).maxAcceptancePlanRepairs,
    0
  )
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '2', null]) {
    await fs.writeFile(
      file,
      JSON.stringify({ maxAcceptancePlanRepairs: value })
    )
    await assert.rejects(
      resolveEpicConfiguration(f.root),
      /maxAcceptancePlanRepairs/
    )
  }
})

test('previous checklist-free schema 8/machine 13 is explicitly incompatible', async t => {
  const f = await fixture(t, [])
  const old = { schemaVersion: 8, machineVersion: 13, ...f.metadata, snapshot: {} }
  assert.throws(() => parsePersistedEpicEnvelope(old), /found schema\/machine version 8\/13.*Required schema\/machine version 13\/14; no compatibility migration was applied/)
})
