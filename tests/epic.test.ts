import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createActor } from 'xstate'
import {
  createEpicMachine,
  EPIC_MACHINE_VERSION,
  EPIC_SCHEMA_VERSION,
  validateTaskExecutionResult,
} from '../pi/extensions/epic/machines/epic-machine.ts'
import { createTaskExecutionMachine } from '../pi/extensions/epic/machines/task-execution-machine.ts'
import { projectActorSystemSnapshot } from '../pi/extensions/epic/machines/actor-system-projection.ts'
import {
  appendEvent,
  loadActiveEpic,
  saveState,
} from '../pi/extensions/epic/persistence.ts'
import { EpicRuntime } from '../pi/extensions/epic/runtime.ts'
import type {
  EpicDomainState,
  ReviewResult,
} from '../pi/extensions/epic/types.ts'
import type { EpicServices } from '../pi/extensions/epic/services.ts'

function domain(root = '/repo'): EpicDomainState {
  return {
    epicId: 'run-1',
    epic: 'Refactor epic',
    repositoryRoot: root,
    epicComplexity: 'moderate',
    scoutRound: 0,
    maxScoutRounds: 3,
    planPath: path.join(root, '.pi', 'epics', 'runs', 'run-1', 'plan.md'),
    planRevision: 0,
    planApproved: true,
    currentTaskIndex: 0,
    taskApproved: false,
    implementationAttempt: 0,
    maxFastRepairs: 1,
    maxFullRepairs: 1,
    maxSemanticRepairs: 1,
  }
}
const timer = { setTimeout, clearTimeout }
function task(id: string) {
  return {
    id,
    title: id,
    objective: id,
    files: { context: [], expectedChanges: [] },
    implementation: [],
    acceptanceCriteria: [],
    verification: [],
    manualReviewSteps: [],
    risks: [],
    requiredChecks: [],
    deferredChecks: [],
    reason: '',
  }
}

function services(): EpicServices {
  const passthrough = async (state: EpicDomainState) => state
  return {
    ctx: {} as never,
    now: () => '2026-01-01T00:00:00.000Z',
    notify: () => undefined,
    classify: (state) => state,
    scout: async (state) => ({
      state,
      report: {
        epicSummary: '',
        relevantFiles: [],
        codeExcerpts: [],
        callPaths: [],
        dataFlow: [],
        existingPatterns: [],
        tests: [],
        verificationCommands: [],
        architectureConstraints: [],
        risks: [],
        uncertainties: [],
      },
    }),
    plan: async (state) => ({ state, result: 'plan' }),
    approvePlan: passthrough,
    reviewPlan: async (state) => ({ state, revised: false }),
    decompose: passthrough,
    prerequisites: passthrough,
    preparePrerequisites: passthrough,
    implement: passthrough,
    serve: (_state, callbacks) => {
      callbacks.ready({
        command: 'true',
        args: [],
        url: 'http://127.0.0.1/',
        stdoutPreview: '',
        stderrPreview: '',
        outputTruncated: false,
      })
      return () => undefined
    },
    browserSmoke: async (state, server) => ({
      state,
      result: {
        passed: true,
        url: server.url,
        readySelector: 'body',
        durationMs: 1,
        findings: [],
        server,
      },
    }),
    checks: async (state, suite) => ({
      state,
      result: {
        suite,
        passed: true,
        checks: [],
        introducedFindings: [],
        preExistingFindings: [],
        deferredChecks: [],
      },
    }),
    review: async (state) => ({
      state,
      result: {
        passed: true,
        summary: '',
        acceptanceCriteria: [],
        findings: [],
      },
    }),
    reviseTask: passthrough,
    checkpointTask: passthrough,
    recordRecovery: passthrough,
    approveRecovery: passthrough,
  }
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}

test('projection exhaustively derives parent and configured human boundaries', () => {
  assert.deepEqual(projectActorSystemSnapshot({ value: 'idle' }), {
    stage: 'idle',
    wait: 'active',
  })
  assert.deepEqual(
    projectActorSystemSnapshot({ value: { planning: 'awaitingReview' } }),
    {
      stage: 'awaiting_plan_review',
      wait: 'awaiting-human',
      pendingHumanAction: 'approve_plan',
    }
  )
  assert.deepEqual(
    projectActorSystemSnapshot({ value: { planning: 'awaitingApproval' } }),
    {
      stage: 'awaiting_plan_approval',
      wait: 'awaiting-human',
      pendingHumanAction: 'approve_plan',
    }
  )
  assert.deepEqual(
    projectActorSystemSnapshot({
      value: { prerequisites: 'awaitingApproval' },
    }),
    {
      stage: 'awaiting_prerequisite_approval',
      wait: 'awaiting-human',
      pendingHumanAction: 'approve_prerequisites',
    }
  )
  assert.deepEqual(
    projectActorSystemSnapshot({ value: { terminal: 'completed' } }),
    { stage: 'completed', wait: 'terminal' }
  )
})

test('parent operational failures wait for explicit recovery approval and retry the failed operation', async () => {
  let attempts = 0
  const base = services()
  const actor = createActor(
    createEpicMachine({
      ...base,
      classify: (state) => {
        attempts += 1
        if (attempts === 1) throw new Error('provider temporarily unavailable')
        return state
      },
      recordRecovery: async (state) => ({
        ...state,
        failureReason: 'provider temporarily unavailable',
      }),
      approveRecovery: async (state) => ({
        ...state,
        failureReason: undefined,
      }),
    }),
    { input: { state: domain() } }
  )
  actor.start()
  actor.send({ type: 'EPIC.START' })
  await nextTurn()
  await nextTurn()
  assert.deepEqual(actor.getSnapshot().value, {
    recovering: 'awaitingApproval',
  })
  assert.equal(
    projectActorSystemSnapshot(actor.getSnapshot()).pendingHumanAction,
    'approve_recovery'
  )
  actor.send({ type: 'RECOVERY.APPROVE' })
  await nextTurn()
  await nextTurn()
  assert.equal(attempts, 2)
  assert.deepEqual(actor.getSnapshot().value, { planning: 'awaitingReview' })
  actor.stop()
})

test('projection characterizes every configured parent and task state', () => {
  const parents: [unknown, string][] = [
    ['classifying', 'classifying'],
    ['decomposingTasks', 'decomposing_tasks'],
    ['escalating', 'escalating'],
    ['finalVerification', 'final_verification'],
    [{ planning: 'scouting' }, 'scouting'],
    [{ planning: 'generating' }, 'planning'],
    [{ planning: 'revising' }, 'revising_plan'],
    [{ planning: 'approving' }, 'planning'],
    [{ prerequisites: 'checking' }, 'checking_prerequisites'],
    [{ prerequisites: 'preparing' }, 'preparing_prerequisites'],
    [{ terminal: 'failed' }, 'failed'],
  ]
  for (const [value, stage] of parents)
    assert.equal(projectActorSystemSnapshot({ value }).stage, stage)
  const children: [string, string][] = [
    ['awaitingApproval', 'awaiting_task_approval'],
    ['revisingTask', 'revising_task'],
    ['implementing', 'implementing'],
    ['fastChecks', 'running_fast_checks'],
    ['repairingFast', 'repairing_fast_checks'],
    ['repairingFastInvoke', 'repairing_fast_checks'],
    ['fullChecks', 'running_full_checks'],
    ['repairingFull', 'repairing_full_checks'],
    ['repairingFullInvoke', 'repairing_full_checks'],
    ['reviewing', 'reviewing'],
    ['repairingReview', 'repairing_review'],
    ['repairingReviewInvoke', 'repairing_review'],
    ['awaitingReview', 'awaiting_task_review'],
    ['escalating', 'escalating'],
    ['done', 'final_verification'],
    ['failed', 'failed'],
  ]
  for (const [value, stage] of children) {
    const view = projectActorSystemSnapshot({
      value: 'taskExecution',
      children: {
        'task-execution': {
          snapshot: {
            value,
            context: {
              repairs: { fast: 0, full: 0, semantic: 0 },
              ...(value === 'escalating'
                ? { domain: { failureReason: 'task actor failed.' } }
                : {}),
            },
          },
        },
      },
    })
    assert.equal(view.stage, stage)
  }
  const browserView = projectActorSystemSnapshot({
    value: 'taskExecution',
    children: {
      'task-execution': {
        snapshot: {
          value: { browserVerification: 'startingDevServer' },
          context: {
            repairs: { fast: 0, full: 0, semantic: 0 },
            domain: domain(),
          },
        },
      },
    },
  })
  assert.equal(browserView.stage, 'starting_dev_server')
})

test('child escalation projects its failure diagnostics', () => {
  assert.deepEqual(
    projectActorSystemSnapshot({
      value: 'taskExecution',
      children: {
        'task-execution': {
          snapshot: {
            value: 'escalating',
            context: {
              domain: {
                failureReason: 'semantic review repair limit exhausted.',
              },
              repairs: { fast: 0, full: 0, semantic: 2 },
            },
          },
        },
      },
    }),
    {
      stage: 'escalating',
      wait: 'awaiting-human',
      pendingHumanAction: 'resolve_escalation',
      task: {
        state: 'escalating',
        repairs: { fast: 0, full: 0, semantic: 2 },
      },
      failureDiagnostics: {
        reason: 'semantic review repair limit exhausted.',
        repairs: { fast: 0, full: 0, semantic: 2 },
      },
    }
  )
})

test('projection uses the persisted child snapshot and rejects malformed child state', () => {
  const snapshot = {
    value: 'taskExecution',
    children: {
      'task-execution': {
        snapshot: {
          value: 'awaitingReview',
          context: { repairs: { fast: 1, full: 0, semantic: 2 } },
        },
      },
    },
  }
  assert.deepEqual(projectActorSystemSnapshot(snapshot), {
    stage: 'awaiting_task_review',
    wait: 'awaiting-human',
    pendingHumanAction: 'review_task',
    task: {
      state: 'awaitingReview',
      repairs: { fast: 1, full: 0, semantic: 2 },
    },
  })
  assert.throws(
    () => projectActorSystemSnapshot({ value: 'taskExecution', children: {} }),
    /task-execution/
  )
  assert.throws(
    () =>
      projectActorSystemSnapshot({
        value: 'idle',
        children: {
          'task-execution': { snapshot: { value: 'awaitingApproval' } },
        },
      }),
    /outside taskExecution/
  )
  assert.throws(
    () => projectActorSystemSnapshot({ value: { planning: 'unknown' } }),
    /Unknown planning/
  )
})

test('task actor owns repair attempts and emits a typed completed result', async () => {
  const machine = createTaskExecutionMachine(services())
  const actor = createActor(machine, { input: { domain: domain() } })
  actor.start()
  actor.send({ type: 'TASK.APPROVE' })
  await nextTurn()
  await nextTurn()
  await nextTurn()
  const child = actor.getSnapshot()
  assert.equal(child.value, 'awaitingReview')
  assert.deepEqual(child.context.repairs, { fast: 0, full: 0, semantic: 0 })
  actor.send({ type: 'TASK.APPROVE' })
  await nextTurn()
  assert.equal(actor.getSnapshot().status, 'done')
  const output = actor.getSnapshot().output as {
    kind: string
    domain: EpicDomainState
    repairs: unknown
  }
  assert.equal(output.kind, 'completed')
  assert.equal(output.domain.taskApproved, true)
  assert.deepEqual(output.repairs, { fast: 0, full: 0, semantic: 0 })
  actor.stop()
})

test('fast repair exhaustion remains in the child snapshot with its exact attempt count', async () => {
  const exhausted = { ...domain(), maxFastRepairs: 0 }
  const failingServices: EpicServices = {
    ...services(),
    checks: async (state, suite) => ({
      state,
      result: {
        suite,
        passed: suite !== 'fast',
        checks: [],
        introducedFindings: [],
        preExistingFindings: [],
        deferredChecks: [],
      },
    }),
  }
  const actor = createActor(createTaskExecutionMachine(failingServices), {
    input: { domain: exhausted },
  })
  actor.start()
  actor.send({ type: 'TASK.APPROVE' })
  await nextTurn()
  await nextTurn()
  await nextTurn()
  assert.equal(actor.getSnapshot().value, 'escalating')
  assert.deepEqual(actor.getSnapshot().context.repairs, {
    fast: 0,
    full: 0,
    semantic: 0,
  })
  assert.equal(
    actor.getSnapshot().context.failureReason,
    'fast checks repair limit exhausted.'
  )
  actor.stop()
})

test('full and semantic repair limits escalate in the child without parent counter synchronization', async () => {
  const cases: {
    label: string
    domain: EpicDomainState
    services: EpicServices
    reason: string
  }[] = [
    {
      label: 'full',
      domain: { ...domain(), maxFullRepairs: 0 },
      reason: 'full checks repair limit exhausted.',
      services: {
        ...services(),
        checks: async (state, suite) => ({
          state,
          result: {
            suite,
            passed: suite !== 'full',
            checks: [],
            introducedFindings: [],
            preExistingFindings: [],
            deferredChecks: [],
          },
        }),
      },
    },
    {
      label: 'semantic',
      domain: { ...domain(), maxSemanticRepairs: 0 },
      reason: 'semantic review repair limit exhausted.',
      services: {
        ...services(),
        review: async (state) => ({
          state,
          result: {
            passed: false,
            summary: '',
            acceptanceCriteria: [],
            findings: [],
          },
        }),
      },
    },
  ]
  for (const item of cases) {
    const actor = createActor(createTaskExecutionMachine(item.services), {
      input: { domain: item.domain },
    })
    actor.start()
    actor.send({ type: 'TASK.APPROVE' })
    for (let turn = 0; turn < 6; turn += 1) await nextTurn()
    assert.equal(actor.getSnapshot().value, 'escalating', item.label)
    assert.equal(actor.getSnapshot().context.failureReason, item.reason)
    actor.stop()
  }
})

test('semantic repair reruns implementation, fast checks, full checks, then review', async () => {
  const calls: string[] = []
  let reviewAttempt = 0
  const tracked: EpicServices = {
    ...services(),
    implement: async (state) => {
      calls.push('implement')
      return state
    },
    checks: async (state, suite) => {
      calls.push(suite)
      return {
        state,
        result: {
          suite,
          passed: true,
          checks: [],
          introducedFindings: [],
          preExistingFindings: [],
          deferredChecks: [],
        },
      }
    },
    review: async (state) => {
      calls.push('review')
      reviewAttempt += 1
      return {
        state,
        result: {
          passed: reviewAttempt > 1,
          summary: '',
          acceptanceCriteria: [],
          findings: [],
        },
      }
    },
  }
  const actor = createActor(createTaskExecutionMachine(tracked), {
    input: { domain: domain() },
  })
  actor.start()
  actor.send({ type: 'TASK.APPROVE' })
  for (let turn = 0; turn < 10; turn += 1) await nextTurn()
  assert.equal(actor.getSnapshot().value, 'awaitingReview')
  assert.deepEqual(calls, [
    'implement',
    'fast',
    'full',
    'review',
    'implement',
    'fast',
    'full',
    'review',
  ])
  assert.deepEqual(actor.getSnapshot().context.repairs, {
    fast: 0,
    full: 0,
    semantic: 1,
  })
  actor.stop()
})

test('browser smoke gates semantic review and cleans up the supervised server', async () => {
  const calls: string[] = []
  let cleanups = 0
  const epicServices = services()
  epicServices.implement = async (state) => {
    calls.push('implement')
    return {
      ...state,
      devServer: {
        command: 'npm',
        args: ['run', 'dev'],
        url: 'http://127.0.0.1:4173/',
        readySelector: 'main',
      },
    }
  }
  epicServices.checks = async (state, suite) => {
    calls.push(suite)
    return {
      state,
      result: {
        suite,
        passed: true,
        checks: [],
        introducedFindings: [],
        preExistingFindings: [],
        deferredChecks: [],
      },
    }
  }
  epicServices.serve = (_state, callbacks) => {
    calls.push('serve')
    queueMicrotask(() =>
      callbacks.ready({
        command: 'npm',
        args: ['run', 'dev'],
        url: 'http://127.0.0.1:4173/',
        stdoutPreview: 'ready',
        stderrPreview: '',
        outputTruncated: false,
      })
    )
    return () => {
      cleanups += 1
    }
  }
  epicServices.browserSmoke = async (state, server) => {
    calls.push('browser-smoke')
    return {
      state,
      result: {
        passed: true,
        url: server.url,
        readySelector: 'main',
        durationMs: 1,
        findings: [],
        server,
      },
    }
  }
  epicServices.review = async (state) => {
    calls.push('review')
    return {
      state,
      result: {
        passed: true,
        summary: 'passed',
        acceptanceCriteria: [],
        findings: [],
      },
    }
  }
  const browserTask = {
    ...task('browser-task'),
    requiredChecks: ['browser-smoke'],
  }
  const actor = createActor(createTaskExecutionMachine(epicServices), {
    input: { domain: { ...domain(), tasks: [browserTask] } },
  })
  actor.start()
  actor.send({ type: 'TASK.APPROVE' })
  for (let turn = 0; turn < 12; turn += 1) await nextTurn()
  assert.equal(actor.getSnapshot().value, 'awaitingReview')
  assert.deepEqual(calls, [
    'implement',
    'fast',
    'full',
    'serve',
    'browser-smoke',
    'review',
  ])
  assert.equal(cleanups, 1)
  actor.stop()
})

test('failed browser smoke consumes the full repair budget and reruns checks', async () => {
  const calls: string[] = []
  let smokeAttempt = 0
  let cleanups = 0
  const epicServices = services()
  epicServices.implement = async (state) => {
    calls.push('implement')
    return {
      ...state,
      devServer: {
        command: 'npm',
        args: ['run', 'dev'],
        url: 'http://127.0.0.1:4173/',
        readySelector: 'main',
      },
    }
  }
  epicServices.checks = async (state, suite) => {
    calls.push(suite)
    return {
      state,
      result: {
        suite,
        passed: true,
        checks: [],
        introducedFindings: [],
        preExistingFindings: [],
        deferredChecks: [],
      },
    }
  }
  epicServices.serve = (_state, callbacks) => {
    calls.push('serve')
    queueMicrotask(() =>
      callbacks.ready({
        command: 'npm',
        args: ['run', 'dev'],
        url: 'http://127.0.0.1:4173/',
        stdoutPreview: '',
        stderrPreview: '',
        outputTruncated: false,
      })
    )
    return () => {
      cleanups += 1
    }
  }
  epicServices.browserSmoke = async (state, server) => {
    smokeAttempt += 1
    calls.push('browser-smoke')
    return {
      state,
      result: {
        passed: smokeAttempt > 1,
        url: server.url,
        readySelector: 'main',
        durationMs: 1,
        findings:
          smokeAttempt > 1
            ? []
            : [
                {
                  source: 'browser-smoke',
                  severity: 'error',
                  message: 'page error',
                },
              ],
        server,
      },
    }
  }
  const browserTask = {
    ...task('browser-task'),
    requiredChecks: ['browser-smoke'],
  }
  const actor = createActor(createTaskExecutionMachine(epicServices), {
    input: { domain: { ...domain(), tasks: [browserTask] } },
  })
  actor.start()
  actor.send({ type: 'TASK.APPROVE' })
  for (let turn = 0; turn < 24; turn += 1) await nextTurn()
  assert.equal(actor.getSnapshot().value, 'awaitingReview')
  assert.equal(calls.filter((call) => call === 'implement').length, 2)
  assert.equal(calls.filter((call) => call === 'browser-smoke').length, 2)
  assert.equal(cleanups, 2)
  assert.equal(actor.getSnapshot().context.repairs.full, 1)
  actor.stop()
})

test('stopping task execution cleans up a server still waiting for readiness', async () => {
  let cleanups = 0
  const epicServices = services()
  epicServices.implement = async (state) => ({
    ...state,
    devServer: {
      command: 'npm',
      args: ['run', 'dev'],
      url: 'http://127.0.0.1:4173/',
      readySelector: 'main',
    },
  })
  epicServices.serve = () => () => {
    cleanups += 1
  }
  const actor = createActor(createTaskExecutionMachine(epicServices), {
    input: {
      domain: {
        ...domain(),
        tasks: [{ ...task('browser-task'), requiredChecks: ['browser-smoke'] }],
      },
    },
  })
  actor.start()
  actor.send({ type: 'TASK.APPROVE' })
  for (let turn = 0; turn < 8; turn += 1) await nextTurn()
  assert.deepEqual(actor.getSnapshot().value, {
    browserVerification: 'startingDevServer',
  })
  actor.stop()
  assert.equal(cleanups, 1)
})

test('semantic repairs may target an unplanned path without scope approval', async () => {
  const calls: string[] = []
  let reviewAttempt = 0
  const scoped = domain()
  scoped.tasks = [task('task-1')]
  const tracked: EpicServices = {
    ...services(),
    implement: async (state, feedback) => {
      calls.push(feedback ? 'implement-with-feedback' : 'implement')
      return state
    },
    review: async (state) => {
      calls.push('review')
      reviewAttempt += 1
      const result: ReviewResult =
        reviewAttempt > 1
          ? {
              passed: true,
              summary: 'The repair is complete.',
              acceptanceCriteria: [],
              findings: [],
            }
          : {
              passed: false,
              summary: 'A shared dependency must change.',
              acceptanceCriteria: [],
              findings: [
                {
                  severity: 'major',
                  category: 'correctness',
                  message: 'The shared dependency violates the task invariant.',
                  failureScenario: 'The feature fails at runtime.',
                  requiredFix: 'Update the shared dependency.',
                  affectedPaths: ['src/shared.ts'],
                  repairPaths: ['src/shared.ts'],
                },
              ],
            }
      return {
        state,
        result,
      }
    },
  }
  const actor = createActor(createTaskExecutionMachine(tracked), {
    input: { domain: scoped },
  })
  actor.start()
  actor.send({ type: 'TASK.APPROVE' })
  for (let turn = 0; turn < 8; turn += 1) await nextTurn()

  assert.equal(actor.getSnapshot().value, 'awaitingReview')
  assert.deepEqual(calls, [
    'implement',
    'review',
    'implement-with-feedback',
    'review',
  ])
  assert.equal(actor.getSnapshot().context.repairs.semantic, 1)
  actor.stop()
})

test('parent transitions through the real child actor without copying child context', async () => {
  const machine = createEpicMachine(services())
  const actor = createActor(machine, { input: { state: domain() } })
  actor.start()
  actor.send({ type: 'EPIC.START' })
  await nextTurn()
  await nextTurn()
  await nextTurn()
  assert.equal(
    projectActorSystemSnapshot(actor.getSnapshot()).stage,
    'awaiting_plan_review'
  )
  assert.equal('fastRepairAttempt' in actor.getSnapshot().context.state, false)
  actor.stop()
})

test('dispatch acknowledges the processing actor before settling a human boundary', async () => {
  const state = domain()
  const machine = createEpicMachine(services())
  const actor = createActor(machine, { input: { state } })
  const runtime = new EpicRuntime(
    actor as never,
    state,
    {
      epicId: state.epicId,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    timer
  )
  actor.start()
  const started = await runtime.dispatchAndSettle({ type: 'EPIC.START' }, 1_000)
  assert.equal(started.stage, 'awaiting_plan_review')
  const reviewed = await runtime.dispatchAndSettle(
    { type: 'PLAN.REVIEW' },
    1_000
  )
  assert.equal(reviewed.stage, 'awaiting_plan_review')
  const prerequisites = await runtime.dispatchAndSettle(
    { type: 'PLAN.APPROVE' },
    1_000
  )
  assert.equal(prerequisites.stage, 'awaiting_prerequisite_approval')
  const taskApproval = await runtime.dispatchAndSettle(
    { type: 'PREREQUISITES.APPROVE' },
    1_000
  )
  assert.equal(taskApproval.stage, 'awaiting_task_approval')
  assert.equal(
    projectActorSystemSnapshot(
      runtime.persistedSnapshot() as unknown as {
        value: unknown
        children?: Record<string, unknown>
      }
    ).task?.state,
    'awaitingApproval'
  )
  assert.throws(
    () => runtime.dispatchAndSettle({ type: 'PREREQUISITES.APPROVE' }, 1_000),
    /not available/
  )
  actor.stop()
})

test('sequential tasks advance the parent index exactly once and start fresh child repairs', async () => {
  const state = { ...domain(), tasks: [task('one'), task('two')] }
  const actor = createActor(createEpicMachine(services()), { input: { state } })
  const runtime = new EpicRuntime(
    actor as never,
    state,
    {
      epicId: state.epicId,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    timer
  )
  actor.start()
  await runtime.dispatchAndSettle({ type: 'EPIC.START' }, 1_000)
  await runtime.dispatchAndSettle({ type: 'PLAN.APPROVE' }, 1_000)
  await runtime.dispatchAndSettle({ type: 'PREREQUISITES.APPROVE' }, 1_000)
  await runtime.dispatchAndSettle({ type: 'TASK.APPROVE' }, 1_000)
  const nextTask = await runtime.dispatchAndSettle(
    { type: 'TASK.APPROVE' },
    1_000
  )
  assert.equal(nextTask.stage, 'awaiting_task_approval')
  assert.equal(runtime.domain().currentTaskIndex, 1)
  assert.deepEqual(nextTask.task?.repairs, { fast: 0, full: 0, semantic: 0 })
  await runtime.dispatchAndSettle({ type: 'TASK.APPROVE' }, 1_000)
  const completed = await runtime.dispatchAndSettle(
    { type: 'TASK.APPROVE' },
    1_000
  )
  assert.equal(completed.stage, 'completed')
  assert.equal(runtime.domain().currentTaskIndex, 1)
  actor.stop()
})

test('real persisted snapshots restore plan, prerequisite, and task human boundaries', async () => {
  const state = domain()
  const machine = createEpicMachine(services())
  const actor = createActor(machine, { input: { state } })
  const runtime = new EpicRuntime(
    actor as never,
    state,
    {
      epicId: state.epicId,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    timer
  )
  actor.start()
  const expected = [
    'awaiting_plan_review',
    'awaiting_prerequisite_approval',
    'awaiting_task_approval',
  ]
  await runtime.dispatchAndSettle({ type: 'EPIC.START' }, 1_000)
  for (const event of [
    { type: 'PLAN.APPROVE' } as const,
    { type: 'PREREQUISITES.APPROVE' } as const,
  ]) {
    const snapshot = runtime.persistedSnapshot()
    const restored = createActor(machine, {
      snapshot: snapshot as never,
      input: { state },
    })
    restored.start()
    assert.equal(
      projectActorSystemSnapshot(restored.getSnapshot()).stage,
      expected.shift()
    )
    restored.stop()
    await runtime.dispatchAndSettle(event, 1_000)
  }
  const snapshot = runtime.persistedSnapshot()
  const restored = createActor(machine, {
    snapshot: snapshot as never,
    input: { state },
  })
  restored.start()
  assert.equal(
    projectActorSystemSnapshot(restored.getSnapshot()).stage,
    expected.shift()
  )
  restored.stop()
  actor.stop()
})

test('injected timer rejects unsettled dispatches and is cleaned up', async () => {
  let callback: (() => void) | undefined
  let cleared = false
  const controlledTimer = {
    setTimeout: (next: () => void) => {
      callback = next
      return 1 as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: () => {
      cleared = true
    },
  }
  const state = domain()
  const actor = createActor(createEpicMachine(services()), { input: { state } })
  const runtime = new EpicRuntime(
    actor as never,
    state,
    {
      epicId: state.epicId,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    controlledTimer
  )
  actor.start()
  const result = runtime.dispatchAndSettle({ type: 'EPIC.RESUME' }, 1)
  callback?.()
  await assert.rejects(result, /did not settle before timeout/)
  assert.equal(cleared, true)
  actor.stop()
})

test('schema-6 envelope is the sole persisted state and older machine versions are rejected', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'epic-refactor-'))
  const machine = createEpicMachine(services())
  const actor = createActor(machine, { input: { state: domain(root) } })
  actor.start()
  const envelope = {
    schemaVersion: 6 as const,
    machineVersion: 11 as const,
    epicId: 'run-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    snapshot: actor.getPersistedSnapshot(),
  }
  await saveState(domain(root), envelope)
  const stored = JSON.parse(
    await fs.readFile(
      path.join(root, '.pi/epics/runs/run-1/state.json'),
      'utf8'
    )
  ) as Record<string, unknown>
  assert.deepEqual(Object.keys(stored).sort(), [
    'createdAt',
    'epicId',
    'machineVersion',
    'schemaVersion',
    'snapshot',
    'updatedAt',
  ])
  const loaded = await loadActiveEpic(root)
  assert.equal(loaded.schemaVersion, 6)
  assert.equal(loaded.machineVersion, 11)
  assert.equal(loaded.epicId, envelope.epicId)
  stored.schemaVersion = 5
  stored.machineVersion = 9
  await fs.writeFile(
    path.join(root, '.pi/epics/runs/run-1/state.json'),
    JSON.stringify(stored)
  )
  await assert.rejects(
    loadActiveEpic(root),
    /found schema\/machine version 5\/9.*Required schema\/machine version 6\/11/
  )
  await fs.writeFile(
    path.join(root, '.pi/epics/runs/run-1/state.json'),
    JSON.stringify({ ...envelope, snapshot: { value: 'idle', context: {} } })
  )
  await assert.rejects(loadActiveEpic(root), /invalid domain state/)
  actor.stop()
  await fs.rm(root, { recursive: true, force: true })
})

test('journal records use explicitly supplied projected stage and timestamp', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'epic-journal-'))
  const current = domain(root)
  const actor = createActor(createEpicMachine(services()), {
    input: { state: current },
  })
  actor.start()
  const envelope = {
    schemaVersion: 6 as const,
    machineVersion: 11 as const,
    epicId: current.epicId,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    snapshot: actor.getPersistedSnapshot(),
  }
  await saveState(current, envelope)
  await appendEvent(current, 'idle', '2026-01-01T00:00:01.000Z', 'test_event', {
    ok: true,
  })
  const [event] = (
    await fs.readFile(
      path.join(root, '.pi/epics/runs/run-1/events.jsonl'),
      'utf8'
    )
  )
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as {
          stage: string
          timestamp: string
          type: string
          payload: unknown
        }
    )
  assert.equal(event?.stage, 'idle')
  assert.equal(event?.timestamp, '2026-01-01T00:00:01.000Z')
  assert.equal(event?.type, 'test_event')
  assert.deepEqual(event?.payload, { ok: true })
  actor.stop()
  await fs.rm(root, { recursive: true, force: true })
})

test('machine version constants accept only schema 6/machine 11', () => {
  assert.equal(EPIC_SCHEMA_VERSION, 6)
  assert.equal(EPIC_MACHINE_VERSION, 11)
})

test('malformed child completion output and reason-less escalation fail explicitly', () => {
  assert.throws(
    () => validateTaskExecutionResult(undefined),
    /without an output/
  )
  assert.throws(
    () =>
      validateTaskExecutionResult({
        kind: 'completed',
        domain: domain(),
        repairs: { fast: -1, full: 0, semantic: 0 },
      }),
    /repair attempts/
  )
  assert.throws(
    () =>
      validateTaskExecutionResult({
        kind: 'escalated',
        domain: domain(),
        repairs: { fast: 0, full: 0, semantic: 0 },
      }),
    /failure reason/
  )
})
