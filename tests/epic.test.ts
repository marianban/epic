import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  appendEvent,
  loadActiveEpic,
  persistEpic,
  persistEpicTasks,
  saveState,
} from '../pi/extensions/epic/persistence.ts'
import { createEpicRuntime } from '../pi/extensions/epic/runtime.ts'
import { createActor } from 'xstate'
import {
  logEpic,
  epicLogPath,
} from '../pi/extensions/epic/logger.ts'
import { createAgentRunStdoutLog } from '../pi/extensions/epic/agent-runs.ts'
import {
  extractReviewInstructions,
  hashPlan,
  validatePlanCompleteness,
} from '../pi/extensions/epic/plan-review.ts'
import {
  normalizeFallowDelta,
  runCheckSuite,
} from '../pi/extensions/epic/checks.ts'
import {
  parsePlannerResponse,
  parseTaskDecomposition,
} from '../pi/extensions/epic/agents.ts'
import { implementerTask } from '../pi/extensions/epic/prompts.ts'
import { createEpicState } from '../pi/extensions/epic/state.ts'
import { epicMachine } from '../pi/extensions/epic/machines/epic-machine.ts'
import {
  assertRepositoryPath,
  isSafeReadOnlyCommand,
} from '../pi/extensions/epic/tools.ts'
import { discoverPrerequisites } from '../pi/extensions/epic/prerequisites.ts'
import { formatEscalationMessage } from '../pi/extensions/epic/epic.ts'
import {
  createEpicMachine,
  machineStage,
} from '../pi/extensions/epic/machines/epic-machine.ts'
import { createTaskExecutionMachine } from '../pi/extensions/epic/machines/task-execution-machine.ts'
import type { EpicMachineContext } from '../pi/extensions/epic/machines/epic-machine.ts'
import type { EpicServices } from '../pi/extensions/epic/services.ts'
import type { EpicState } from '../pi/extensions/epic/types.ts'

const validPlan = `# Implementation Plan

## Status
Draft — awaiting human approval.
## Objective
Do the thing.
## Scope
### Read
- src/example.ts
### Modify
- src/example.ts
### Create
- None.
### Delete
- None.
## Repository Findings
The existing implementation is the owner.
## Proposed Design
Extend the existing implementation.
## Implementation Steps
1. Update the existing implementation.
## Acceptance Criteria
- [ ] The behavior is covered.
## Verification
- npm test
## Risks and Edge Cases
- None.
## Open Questions
- None.
## Revision Log
### Revision 1
- Initial plan.
`

function createTestEpicServices(): EpicServices {
  return {
    ctx: undefined as never,
    notify: () => undefined,
    classify: (value) => value,
    scout: async (value) => ({ state: value, report: {} as never }),
    plan: async (value) => ({ state: value, result: 'plan' }),
    approvePlan: async (value) => value,
    reviewPlan: async (value) => ({ state: value, revised: false }),
    decompose: async (value) => value,
    prerequisites: async (value) => ({ ...value, prerequisites: [] }),
    preparePrerequisites: async (value) => value,
    implement: async (value) => value,
    checks: async (value, suite) => ({
      state: value,
      result: {
        suite,
        passed: true,
        checks: [],
        introducedFindings: [],
        preExistingFindings: [],
        deferredChecks: [],
      },
    }),
    review: async (value) => ({
      state: value,
      result: {
        passed: true,
        summary: 'passed',
        acceptanceCriteria: [],
        findings: [],
        requiresPlanRevision: false,
      },
    }),
    reviseTask: async (value) => value,
  }
}

test('root actor accepts domain events only in valid states', () => {
  const state = createEpicState('/repo', 'task', '2026-01-01T00:00:00.000Z')
  const actor = createActor(epicMachine, { input: { state } })
  actor.start()
  assert.equal(actor.getSnapshot().can({ type: 'EPIC.START' }), true)
  assert.equal(actor.getSnapshot().can({ type: 'TASK.APPROVE' }), false)
  actor.send({ type: 'EPIC.START' })
  assert.equal(actor.getSnapshot().value, 'classifying')
  actor.stop()
})

test('escalation notifications include the persisted failure reason', () => {
  assert.equal(
    formatEscalationMessage(
      {
        stage: 'escalating',
        failureReason: 'Task T1 requires unavailable check(s): fallow.',
      },
      'Inspect the failure and run /epic-resume to retry, or /epic-cancel.'
    ),
    'Task T1 requires unavailable check(s): fallow. Inspect the failure and run /epic-resume to retry, or /epic-cancel.'
  )
  assert.equal(
    formatEscalationMessage({ stage: 'awaiting_task_review' }, 'Review the task.'),
    'Review the task.'
  )
})

test('task execution stage follows the invoked child actor', () => {
  const state = createEpicState('/repo', 'task', '2026-01-01T00:00:00.000Z')
  const context = {
    state: { ...state, stage: 'reviewing' as const },
  } as EpicMachineContext

  assert.equal(machineStage({ value: 'taskExecution', context }), 'reviewing')
  assert.equal(
    machineStage({
      value: 'taskExecution',
      context: {
        state: { ...state, stage: 'awaiting_task_review' },
      } as EpicMachineContext,
    }),
    'awaiting_task_review'
  )
  assert.equal(
    machineStage({
      value: 'taskExecution',
      context: {
        state: { ...state, stage: 'escalating' },
      } as EpicMachineContext,
    }),
    'escalating'
  )
})

test('agent stdout is persisted to a unique per-run log before close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-agent-runs-'))
  try {
    const directory = join(root, 'agent-runs')
    const first = createAgentRunStdoutLog(directory, 'planner')
    first.append(Buffer.from('{"type":"message_start"}\n'))
    assert.equal(
      await readFile(first.filePath, 'utf8'),
      '{"type":"message_start"}\n'
    )
    first.close()

    const second = createAgentRunStdoutLog(directory, 'planner')
    second.append(Buffer.from('{"type":"agent_end"}\n'))
    second.close()

    assert.notEqual(first.filePath, second.filePath)
    assert.deepEqual((await readdir(directory)).sort(), [
      first.filePath.split('/').pop(),
      second.filePath.split('/').pop(),
    ].sort())
    assert.equal(await readFile(second.filePath, 'utf8'), '{"type":"agent_end"}\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('task execution actor exposes final output to its invoking parent', async () => {
  const state = createEpicState('/repo', 'task')
  const services = createTestEpicServices()
  const actor = createActor(createTaskExecutionMachine(services), {
    input: { state },
  })
  actor.start()
  actor.send({ type: 'TASK.APPROVE' })
  for (let i = 0; i < 10 && actor.getSnapshot().value !== 'awaitingReview'; i++)
    await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(actor.getSnapshot().value, 'awaitingReview')
  assert.equal(actor.getSnapshot().context.state.taskApproved, true)
  assert.ok(actor.getSnapshot().context.state.taskApprovedAt)

  actor.send({ type: 'TASK.APPROVE' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(actor.getSnapshot().status, 'done')
  assert.equal(
    (actor.getSnapshot().output as { kind?: string } | undefined)?.kind,
    'completed'
  )
  actor.stop()
})

test('task escalation keeps durable root and snapshot stages aligned', async () => {
  const state = createEpicState('/repo', 'task')
  const services = createTestEpicServices()
  services.checks = async (value, suite) => {
    if (suite === 'full') throw new Error('full checks unavailable')
    return {
      state: value,
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
  const actor = createActor(createEpicMachine(services), {
    input: { state },
  })
  actor.start()
  actor.send({ type: 'EPIC.START' })
  for (
    let i = 0;
    i < 10 && JSON.stringify(actor.getSnapshot().value) !==
      JSON.stringify({ planning: 'awaitingReview' });
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 0))
  actor.send({ type: 'PLAN.APPROVE' })
  const childValue = () =>
    (
      actor.getSnapshot().children['task-execution']?.getSnapshot?.() as
        | { value?: unknown }
        | undefined
    )?.value
  for (
    let i = 0;
    i < 10 && childValue() !== 'awaitingApproval';
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 0))
  actor.send({ type: 'TASK.APPROVE' })
  for (let i = 0; i < 10 && actor.getSnapshot().value !== 'escalating'; i++)
    await new Promise((resolve) => setTimeout(resolve, 0))

  const snapshot = actor.getSnapshot()
  const persisted = actor.getPersistedSnapshot() as unknown as {
    value: unknown
    context: { state: { stage: string; pendingHumanAction?: string } }
  }
  assert.equal(snapshot.value, 'escalating')
  assert.equal(snapshot.context.state.stage, 'escalating')
  assert.equal(snapshot.context.state.pendingHumanAction, 'resolve_escalation')
  assert.equal(persisted.value, 'escalating')
  assert.equal(persisted.context.state.stage, 'escalating')
  actor.stop()
})

test('task child snapshots synchronize approval and repair counters to the root', async () => {
  const state = createEpicState('/repo', 'task')
  const services = createTestEpicServices()
  services.implement = async (value, feedback = '') => ({
    ...value,
    implementationAttempt: value.implementationAttempt + (feedback ? 0 : 1),
  })
  services.review = async (value) => ({
    state: value,
    result: {
      passed: false,
      summary: 'verification evidence is missing',
      acceptanceCriteria: [],
      findings: [],
      requiresPlanRevision: false,
    },
  })
  const actor = createActor(createEpicMachine(services), {
    input: { state },
  })
  actor.start()
  actor.send({ type: 'EPIC.START' })
  for (
    let i = 0;
    i < 20 && JSON.stringify(actor.getSnapshot().value) !==
      JSON.stringify({ planning: 'awaitingReview' });
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 0))
  actor.send({ type: 'PLAN.APPROVE' })
  const child = () =>
    actor.getSnapshot().children['task-execution']?.getSnapshot?.() as
      | {
          value?: unknown
          context?: {
            semanticRepairAttempt?: number
            state?: EpicState
          }
        }
      | undefined
  for (let i = 0; i < 20 && child()?.value !== 'awaitingApproval'; i++)
    await new Promise((resolve) => setTimeout(resolve, 0))
  actor.send({ type: 'TASK.APPROVE' })
  for (let i = 0; i < 100 && child()?.value !== 'escalating'; i++)
    await new Promise((resolve) => setTimeout(resolve, 0))

  const snapshot = actor.getSnapshot()
  const childSnapshot = child()
  assert.equal(childSnapshot?.value, 'escalating')
  assert.equal(snapshot.context.state.stage, 'escalating')
  assert.equal(snapshot.context.state.taskApproved, true)
  assert.equal(snapshot.context.state.implementationAttempt, 1)
  assert.equal(snapshot.context.state.semanticRepairAttempt, 2)
  assert.equal(childSnapshot?.context?.semanticRepairAttempt, 2)
  assert.equal(childSnapshot?.context?.state?.taskApproved, true)
  const persisted = actor.getPersistedSnapshot() as unknown as {
    context: { state: EpicState }
  }
  assert.equal(persisted.context.state.taskApproved, true)
  assert.equal(persisted.context.state.semanticRepairAttempt, 2)
  actor.stop()
})

test('completed task re-enters task execution for the next task', async () => {
  const state = createEpicState('/repo', 'task')
  state.tasks = [{ id: 'task-1' } as never, { id: 'task-2' } as never]
  const actor = createActor(
    createEpicMachine(createTestEpicServices()),
    { input: { state } }
  )
  const childValue = () =>
    (
      actor.getSnapshot().children['task-execution']?.getSnapshot?.() as
        | { value?: unknown }
        | undefined
    )?.value
  actor.start()
  actor.send({ type: 'EPIC.START' })
  for (
    let i = 0;
    i < 10 && JSON.stringify(actor.getSnapshot().value) !==
      JSON.stringify({ planning: 'awaitingReview' });
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 0))
  actor.send({ type: 'PLAN.APPROVE' })
  for (
    let i = 0;
    i < 10 && childValue() !== 'awaitingApproval';
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 0))
  actor.send({ type: 'TASK.APPROVE' })
  for (
    let i = 0;
    i < 10 && childValue() !== 'awaitingReview';
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 0))
  actor.send({ type: 'TASK.APPROVE' })
  for (
    let i = 0;
    i < 10 && actor.getSnapshot().context.state.currentTaskIndex !== 1;
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(actor.getSnapshot().context.state.currentTaskIndex, 1)
  assert.equal(childValue(), 'awaitingApproval')
  actor.stop()
})

test('implementer receives human R instructions from the task artifact', () => {
  const state = createEpicState('/repo', 'task', '2026-01-01T00:00:00.000Z')
  const prompt = implementerTask(
    state,
    '# Plan',
    '',
    '## Human Review Instructions\nR: install the project dependencies before running the dev server.'
  )
  assert.match(prompt, /Human R: implementation instructions:/)
  assert.match(prompt, /install the project dependencies/)
})

test('post-plan machine state is visible as the plan review stage', async () => {
  const state = createEpicState('/repo', 'task', '2026-01-01T00:00:00.000Z')
  const services: EpicServices = {
    ctx: undefined as never,
    notify: () => undefined,
    classify: (value) => value,
    scout: async (value) => ({ state: value, report: {} as never }),
    plan: async (value) => ({ state: value, result: '# Plan' }),
    approvePlan: async (value) => value,
    reviewPlan: async (value) => ({ state: value, revised: false }),
    decompose: async (value) => value,
    prerequisites: async (value) => value,
    preparePrerequisites: async (value) => value,
    implement: async (value) => value,
    checks: async (value) => ({
      state: value,
      result: {} as never,
    }),
    review: async (value) => ({ state: value, result: {} as never }),
    reviseTask: async (value) => value,
  }
  const actor = createActor(createEpicMachine(services), { input: { state } })
  actor.start()
  actor.send({ type: 'EPIC.START' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))

  const snapshot = actor.getSnapshot()
  assert.deepEqual(snapshot.value, { planning: 'awaitingReview' })
  assert.equal(
    machineStage(
      snapshot as unknown as { value: unknown; context: EpicMachineContext }
    ),
    'awaiting_plan_review'
  )
  actor.stop()
})

test('R comments preserve line numbers and support Windows line endings', () => {
  const instructions = extractReviewInstructions(
    'one\r\n R: first request \r\nno\r\nR: second request\r\n'
  )
  assert.deepEqual(
    instructions.map((item) => [item.lineNumber, item.text]),
    [
      [2, 'first request'],
      [4, 'second request'],
    ]
  )
})

test('R comments can be appended to plan lines', () => {
  const instructions = extractReviewInstructions(
    '- Support keyboard controls. R: remove pointer controls.\n- Use three lives. R: keep the default lives count.'
  )
  assert.deepEqual(
    instructions.map((item) => [item.lineNumber, item.text]),
    [
      [1, 'remove pointer controls.'],
      [2, 'keep the default lives count.'],
    ]
  )
})

test('plan validation and approval hash are deterministic', () => {
  assert.deepEqual(validatePlanCompleteness(validPlan).valid, true)
  assert.equal(hashPlan(validPlan), hashPlan(validPlan))
  assert.notEqual(hashPlan(validPlan), hashPlan(`${validPlan}\nchanged`))
  assert.equal(
    validatePlanCompleteness(`${validPlan}\nR: resolve this`).valid,
    false
  )
  assert.equal(
    validatePlanCompleteness(
      validPlan.replace('- src/example.ts', '- ../outside.ts')
    ).valid,
    false
  )
})

test('Fallow normalization separates introduced and pre-existing findings', () => {
  const delta = normalizeFallowDelta('ignored text', [
    {
      source: 'fallow',
      severity: 'error',
      file: 'src/a.ts',
      line: 1,
      message: 'old',
    },
  ])
  assert.equal(delta.introduced.length, 1)
  assert.equal(delta.preExisting.length, 0)
  const structured = normalizeFallowDelta(
    JSON.stringify({
      introduced: ['new'],
      preExisting: ['old'],
      resolved: ['fixed'],
    })
  )
  assert.deepEqual(
    structured.introduced.map((finding) => finding.message),
    ['new']
  )
  assert.deepEqual(
    structured.preExisting.map((finding) => finding.message),
    ['old']
  )
  assert.deepEqual(
    structured.resolved.map((finding) => finding.message),
    ['fixed']
  )
})

test('Planner can request bounded focused Scout context', () => {
  const response = parsePlannerResponse(
    JSON.stringify({
      status: 'needs_more_context',
      questions: [
        {
          question: 'Where is the game bootstrap?',
          reason: 'The plan must reuse the existing entrypoint.',
        },
      ],
    })
  )
  assert.equal(typeof response, 'object')
  assert.equal((response as { status: string }).status, 'needs_more_context')
})

test('task decomposition requires independently reviewable task fields', () => {
  const tasks = parseTaskDecomposition(
    JSON.stringify({
      tasks: [
        {
          id: 'task-001',
          title: 'Add behavior',
          objective: 'Add it',
          scope: { read: [], modify: ['src/a.ts'], create: [], delete: [] },
          implementation: ['Update the handler.'],
          acceptanceCriteria: ['The handler returns the expected value.'],
          verification: ['npm test'],
          manualReviewSteps: ['Run the feature and observe the result.'],
          risks: [],
          requiredChecks: ['diff-check'],
          deferredChecks: ['build'],
          reason: 'The entry point is created by a later task.',
        },
      ],
    })
  )
  assert.equal(tasks[0].manualReviewSteps.length, 1)
  assert.deepEqual(tasks[0].requiredChecks, ['diff-check'])
  assert.deepEqual(tasks[0].deferredChecks, ['build'])
  assert.throws(
    () =>
      parseTaskDecomposition(
        JSON.stringify({
          tasks: [
            {
              id: 'task-001',
              title: 'incomplete',
              objective: 'x',
              implementation: [],
              acceptanceCriteria: [],
              verification: [],
              manualReviewSteps: [],
              risks: [],
              requiredChecks: [],
              deferredChecks: [],
              reason: 'No checks are applicable.',
            },
          ],
        })
      ),
    /acceptance criteria/
  )
})

test('task check policy defers checks per task but final verification runs them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-task-check-policy-'))
  try {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        scripts: { build: 'node -e "process.exit(0)"' },
      })
    )
    const state = createEpicState(root, 'task')
    state.tasks = [
      {
        id: 'task-001',
        title: 'Manifest',
        objective: 'Create the manifest.',
        scope: { read: [], modify: [], create: ['package.json'], delete: [] },
        implementation: ['Create package.json.'],
        acceptanceCriteria: ['The manifest exists.'],
        verification: ['npm pkg get name'],
        manualReviewSteps: ['Inspect package.json.'],
        risks: [],
        requiredChecks: ['diff-check'],
        deferredChecks: ['build'],
        reason: 'The browser entry point is created by a later task.',
      },
    ]
    await saveState(state)
    assert.ok(state.tasks)
    const manifestPath = await persistEpicTasks(state, state.tasks)
    assert.match(await readFile(manifestPath, 'utf8'), /"deferredChecks"/)
    const taskMarkdown = await readFile(
      join(
        root,
        '.pi',
        'epics',
        'runs',
        state.epicId,
        'tasks',
        'task-001.md'
      ),
      'utf8'
    )
    assert.match(taskMarkdown, /## Check Policy/)
    assert.match(taskMarkdown, /The browser entry point is created by a later task\./)

    const taskResult = await runCheckSuite('full', state)
    assert.equal(taskResult.passed, true)
    assert.deepEqual(taskResult.deferredChecks, ['build'])
    assert.deepEqual(taskResult.checks[0], {
      name: 'build',
      command: 'npm run build',
      passed: true,
      required: false,
      exitCode: 0,
      durationMs: 0,
      stdoutPreview: '',
      stderrPreview: '',
      findings: [],
      outputTruncated: false,
      skipped: true,
      skipReason: 'The browser entry point is created by a later task.',
    })

    await mkdir(join(root, '.pi'), { recursive: true })
    await writeFile(
      join(root, '.pi', 'epic.config.json'),
      JSON.stringify({ checks: { final: ['node -e "process.exit(0)"'] } })
    )
    const finalResult = await runCheckSuite('final', state)
    assert.equal(finalResult.passed, true)
    assert.equal(finalResult.deferredChecks.length, 0)
    assert.deepEqual(
      finalResult.checks.map((check) => check.name),
      ['final-1', 'build']
    )
    assert.equal(finalResult.checks[1].skipped, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('task check policy skips discovered checks that are not required', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-task-check-allowlist-'))
  try {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        scripts: { build: 'node -e "process.exit(0)"' },
      })
    )
    const state = createEpicState(root, 'task')
    state.tasks = [
      {
        id: 'task-001',
        title: 'Documentation',
        objective: 'Document the project.',
        scope: { read: [], modify: [], create: ['README.md'], delete: [] },
        implementation: ['Create README.md.'],
        acceptanceCriteria: ['The README exists.'],
        verification: ['git diff --check'],
        manualReviewSteps: ['Inspect README.md.'],
        risks: [],
        requiredChecks: ['diff-check'],
        deferredChecks: [],
        reason: 'The task does not change runtime code.',
      },
    ]
    await saveState(state)

    const result = await runCheckSuite('full', state)

    assert.equal(result.passed, true)
    assert.deepEqual(result.deferredChecks, [])
    assert.deepEqual(result.checks[0], {
      name: 'build',
      command: 'npm run build',
      passed: true,
      required: false,
      exitCode: 0,
      durationMs: 0,
      stdoutPreview: '',
      stderrPreview: '',
      findings: [],
      outputTruncated: false,
      skipped: true,
      skipReason: 'Not required by task check policy.',
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('persistence writes an active state and append-only event journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-epic-'))
  try {
    const state = createEpicState(root, 'task')
    const epicPath = await persistEpic(state)
    assert.equal(epicPath, join(root, '.pi', 'epics', 'runs', state.epicId, 'Epic.md'))
    assert.equal(await readFile(epicPath, 'utf8'), '# Epic\n\ntask\n')
    await saveState(state)
    await appendEvent(state, 'epic_created', { test: true })
    const loaded = await loadActiveEpic(root)
    assert.equal(loaded.epicId, state.epicId)
    const journal = await readFile(
      join(root, '.pi', 'epics', 'runs', state.epicId, 'events.jsonl'),
      'utf8'
    )
    assert.equal(journal.trim().split('\n').length, 1)
    const log = await readFile(epicLogPath(root, state.epicId), 'utf8')
    assert.match(log, /DEBUG Epic state saved/)
    assert.match(log, /INFO epic_created/)
    assert.match(log, /"test":true/)
    await logEpic(state, 'info', 'credentials captured', {
      token: 'do-not-write',
    })
    const redactedLog = await readFile(
      epicLogPath(root, state.epicId),
      'utf8'
    )
    assert.match(redactedLog, /"token":"\[REDACTED\]"/)
    assert.doesNotMatch(redactedLog, /do-not-write/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('XState snapshots round-trip and expose machine capabilities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-xstate-snapshot-'))
  try {
    const state = createEpicState(root, 'task')
    await saveState(state)
    const loaded = await loadActiveEpic(root)
    const runtime = await createEpicRuntime(loaded)
    assert.equal(runtime.matches('idle'), true)
    assert.equal(runtime.tags().size, 0)
    runtime.stop()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('unsupported persisted epic versions are rejected without migration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-xstate-incompatible-'))
  try {
    const state = createEpicState(root, 'task')
    await saveState(state)
    const statePath = join(
      root,
      '.pi',
      'epics',
      'runs',
      state.epicId,
      'state.json'
    )
    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as Record<
      string,
      unknown
    >
    persisted.schemaVersion = 2
    persisted.machineVersion = 4
    await writeFile(statePath, `${JSON.stringify(persisted)}\n`)
    await assert.rejects(
      () => loadActiveEpic(root),
      /incompatible.*unsupported persistence version/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('path and read-only command guards block unsafe operations', () => {
  assert.equal(isSafeReadOnlyCommand('git diff --check'), true)
  assert.equal(isSafeReadOnlyCommand('git commit -am bad'), false)
  assert.throws(
    () => assertRepositoryPath('/repo', '../secret.txt'),
    /outside repository/
  )
  assert.throws(() => assertRepositoryPath('/repo', '.env'), /sensitive path/)
})

test('prerequisite discovery proposes git initialization and dependency installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-prerequisites-'))
  try {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { vite: 'latest' } })
    )
    const prerequisites = await discoverPrerequisites(root)
    assert.deepEqual(
      prerequisites.map((item) => item.command),
      ['git init', 'npm install']
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('prerequisite discovery catches an incomplete node_modules directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-prerequisites-partial-'))
  try {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ devDependencies: { vitest: 'latest' } })
    )
    await mkdir(join(root, 'node_modules'))
    const prerequisites = await discoverPrerequisites(root)
    assert.equal(
      prerequisites.some((item) => item.kind === 'node_dependencies'),
      true
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
