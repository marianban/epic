import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  appendEvent,
  loadActiveWorkflow,
  saveState,
} from '../pi/extensions/workflow/persistence.ts'
import { createWorkflowRuntime } from '../pi/extensions/workflow/runtime.ts'
import { createActor } from 'xstate'
import {
  logWorkflow,
  workflowLogPath,
} from '../pi/extensions/workflow/logger.ts'
import {
  extractReviewInstructions,
  hashPlan,
  validatePlanCompleteness,
} from '../pi/extensions/workflow/plan-review.ts'
import { normalizeFallowDelta } from '../pi/extensions/workflow/checks.ts'
import {
  parsePlannerResponse,
  parseTaskDecomposition,
} from '../pi/extensions/workflow/agents.ts'
import { createWorkflowState } from '../pi/extensions/workflow/state.ts'
import { workflowMachine } from '../pi/extensions/workflow/machines/workflow-machine.ts'
import {
  assertRepositoryPath,
  isSafeReadOnlyCommand,
} from '../pi/extensions/workflow/tools.ts'
import { discoverPrerequisites } from '../pi/extensions/workflow/prerequisites.ts'
import {
  createWorkflowMachine,
  machineStage,
} from '../pi/extensions/workflow/machines/workflow-machine.ts'
import type { WorkflowMachineContext } from '../pi/extensions/workflow/machines/workflow-machine.ts'
import type { WorkflowServices } from '../pi/extensions/workflow/services.ts'

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

test('root actor accepts domain events only in valid states', () => {
  const state = createWorkflowState('/repo', 'task', '2026-01-01T00:00:00.000Z')
  const actor = createActor(workflowMachine, { input: { state } })
  actor.start()
  assert.equal(actor.getSnapshot().can({ type: 'WORKFLOW.START' }), true)
  assert.equal(actor.getSnapshot().can({ type: 'TASK.APPROVE' }), false)
  actor.send({ type: 'WORKFLOW.START' })
  assert.equal(actor.getSnapshot().value, 'classifying')
  actor.stop()
})

test('task execution stage follows the invoked child actor', () => {
  const state = createWorkflowState('/repo', 'task', '2026-01-01T00:00:00.000Z')
  const context = {
    state: { ...state, stage: 'reviewing' as const },
  } as WorkflowMachineContext

  assert.equal(machineStage({ value: 'taskExecution', context }), 'reviewing')
  assert.equal(
    machineStage({
      value: 'taskExecution',
      context: {
        state: { ...state, stage: 'awaiting_task_review' },
      } as WorkflowMachineContext,
    }),
    'awaiting_task_review'
  )
})

test('post-plan machine state is visible as the plan review stage', async () => {
  const state = createWorkflowState('/repo', 'task', '2026-01-01T00:00:00.000Z')
  const services: WorkflowServices = {
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
  const actor = createActor(createWorkflowMachine(services), { input: { state } })
  actor.start()
  actor.send({ type: 'WORKFLOW.START' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))

  const snapshot = actor.getSnapshot()
  assert.deepEqual(snapshot.value, { planning: 'awaitingReview' })
  assert.equal(
    machineStage(
      snapshot as unknown as { value: unknown; context: WorkflowMachineContext }
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
        },
      ],
    })
  )
  assert.equal(tasks[0].manualReviewSteps.length, 1)
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
            },
          ],
        })
      ),
    /acceptance criteria/
  )
})

test('persistence writes an active state and append-only event journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-workflow-'))
  try {
    const state = createWorkflowState(root, 'task')
    await saveState(state)
    await appendEvent(state, 'workflow_created', { test: true })
    const loaded = await loadActiveWorkflow(root)
    assert.equal(loaded.workflowId, state.workflowId)
    const journal = await readFile(
      join(root, '.pi', 'workflows', 'runs', state.workflowId, 'events.jsonl'),
      'utf8'
    )
    assert.equal(journal.trim().split('\n').length, 1)
    const log = await readFile(workflowLogPath(root, state.workflowId), 'utf8')
    assert.match(log, /DEBUG Workflow state saved/)
    assert.match(log, /INFO workflow_created/)
    assert.match(log, /"test":true/)
    await logWorkflow(state, 'info', 'credentials captured', {
      token: 'do-not-write',
    })
    const redactedLog = await readFile(
      workflowLogPath(root, state.workflowId),
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
    const state = createWorkflowState(root, 'task')
    await saveState(state)
    const loaded = await loadActiveWorkflow(root)
    const runtime = createWorkflowRuntime(loaded)
    assert.equal(runtime.matches('idle'), true)
    assert.equal(runtime.tags().size, 0)
    runtime.stop()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('unsupported persisted workflow versions are rejected without migration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-xstate-incompatible-'))
  try {
    const state = createWorkflowState(root, 'task')
    await saveState(state)
    const statePath = join(
      root,
      '.pi',
      'workflows',
      'runs',
      state.workflowId,
      'state.json'
    )
    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as Record<
      string,
      unknown
    >
    persisted.schemaVersion = 1
    await writeFile(statePath, `${JSON.stringify(persisted)}\n`)
    await assert.rejects(
      () => loadActiveWorkflow(root),
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
