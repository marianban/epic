import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import epicExtension from '../pi/extensions/epic/index.ts'
import { EPIC_COMMANDS } from '../pi/extensions/epic/commands.ts'
import { DashboardState } from '../pi/extensions/epic/dashboard/state.ts'
import { createEpicState } from '../pi/extensions/epic/state.ts'
import {
  isEpicOperationActive,
  withActiveEpicOperation,
} from '../pi/extensions/epic/operation-status.ts'
import type { EpicTask } from '../pi/extensions/epic/types.ts'

function task(
  overrides: Partial<
    Pick<EpicTask, 'acceptanceCriteria' | 'requiredChecks' | 'deferredChecks'>
  > = {}
): EpicTask {
  return {
    id: 'task-1',
    title: 'Task',
    objective: 'Do the task.',
    scope: { read: [], modify: [], create: [], delete: [] },
    implementation: [],
    acceptanceCriteria: overrides.acceptanceCriteria ?? [],
    verification: [],
    manualReviewSteps: [],
    risks: [],
    requiredChecks: overrides.requiredChecks ?? [],
    deferredChecks: overrides.deferredChecks ?? [],
    reason: 'Needed.',
  }
}

test('progress metrics report valid counts and reject invalid state', () => {
  const state = createEpicState('/repo', 'epic', '2026-01-01T00:00:00.000Z')
  state.tasks = Array.from({ length: 9 }, (_, index) =>
    task({ acceptanceCriteria: index < 4 ? ['criterion'] : [] })
  )
  state.currentTaskIndex = 2

  const dashboard = DashboardState.fromRun({
    state,
    events: [],
  })

  assert.equal(dashboard.epic.tasks.completed, 2)
  assert.equal(dashboard.epic.tasks.total, 9)
  assert.equal(dashboard.epic.tasks.percent, (2 / 9) * 100)
  assert.equal(dashboard.epic.criteria.total, 4)

  state.currentTaskIndex = -2
  assert.throws(
    () =>
      DashboardState.fromRun({
        state,
        events: [],
      }),
    /currentTaskIndex/
  )

  state.currentTaskIndex = 10
  assert.throws(
    () =>
      DashboardState.fromRun({
        state,
        events: [],
      }),
    /currentTaskIndex/
  )

  state.tasks = []
  state.currentTaskIndex = 0
  const empty = DashboardState.fromRun({
    state,
    events: [],
  })
  assert.deepEqual(empty.epic.tasks, { completed: 0, total: 0, percent: 0 })
})

test('status mapping hides internal workflow stage names', () => {
  const state = createEpicState('/repo', 'epic')
  const cases = [
    ['awaiting_plan_review', 'review'],
    ['revising_plan', 'refinement'],
    ['decomposing_tasks', 'decomposing'],
    ['checking_prerequisites', 'decomposed'],
    ['implementing', 'in-progress'],
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['escalating', 'escalating'],
  ] as const

  for (const [stage, expected] of cases) {
    state.stage = stage
    if (stage === 'escalating') state.failureReason = 'A retry is required.'
    assert.equal(
      DashboardState.fromRun({
        state,
        events: [],
        ...(stage === 'completed' || stage === 'failed'
          ? { completedAt: state.updatedAt }
          : {}),
      }).epic.status,
      expected,
      stage
    )
  }
})

test('task and timing values use independent sources', () => {
  const state = createEpicState('/repo', 'epic', '2026-01-01T00:00:00.000Z')
  state.tasks = [
    task({ acceptanceCriteria: ['a', 'b'], requiredChecks: ['typecheck'] }),
    task({ acceptanceCriteria: ['c'], deferredChecks: ['tests'] }),
    task({ acceptanceCriteria: ['d'], requiredChecks: ['lint'] }),
  ]
  state.currentTaskIndex = 1

  const dashboard = DashboardState.fromRun({
    state,
    events: [],
  })

  assert.equal(dashboard.epic.tasks.completed, 1)
  assert.equal(dashboard.epic.criteria.completed, 2)
  assert.equal(dashboard.epic.criteria.total, 4)
  assert.equal(dashboard.epic.agentTimeMs, 0)
})

test('agent events provide execution time and token usage without text inference', () => {
  const state = createEpicState('/repo', 'epic', '2026-01-01T00:00:00.000Z')
  const dashboard = DashboardState.fromRun({
    state,
    events: [
      {
        id: 'start',
        epicId: state.epicId,
        timestamp: '2026-01-01T00:00:01.000Z',
        type: 'agent_started',
        stage: 'implementing',
        payload: { role: 'implementer', action: 'implementation' },
      },
      {
        id: 'finish',
        epicId: state.epicId,
        timestamp: '2026-01-01T00:00:04.000Z',
        type: 'agent_finished',
        stage: 'implementing',
        payload: {
          durationMs: 3_000,
          role: 'implementer',
          action: 'implementation',
          usage: { inputTokens: 100, outputTokens: 25, cached: 5 },
        },
      },
    ],
  })

  assert.equal(dashboard.epic.agentTimeMs, 3_000)
  assert.deepEqual(dashboard.epic.tokens, {
    total: 130,
    input: 100,
    output: 25,
    cached: 5,
  })

  const missing = DashboardState.fromRun({
    state,
    events: [],
  })
  assert.deepEqual(missing.epic.tokens, { total: 0 })
})

test('agent time ignores abandoned starts and merges overlapping runs', () => {
  const state = createEpicState('/repo', 'epic', '2026-01-01T00:00:00.000Z')
  const event = (
    id: string,
    timestamp: string,
    type: 'agent_started' | 'agent_finished',
    role: string
  ) => ({
    id,
    epicId: state.epicId,
    timestamp,
    type,
    stage: 'implementing' as const,
    payload: { role, action: 'implementation' },
  })

  const dashboard = DashboardState.fromRun({
    state,
    events: [
      event(
        'stale-start',
        '2026-01-01T00:00:01.000Z',
        'agent_started',
        'planner'
      ),
      event(
        'real-start',
        '2026-01-01T00:00:05.000Z',
        'agent_started',
        'planner'
      ),
      event(
        'real-finish',
        '2026-01-01T00:00:08.000Z',
        'agent_finished',
        'planner'
      ),
      event(
        'other-start',
        '2026-01-01T00:00:04.000Z',
        'agent_started',
        'scout'
      ),
      event(
        'other-finish',
        '2026-01-01T00:00:10.000Z',
        'agent_finished',
        'scout'
      ),
    ],
  })

  assert.equal(dashboard.epic.agentTimeMs, 6_000)

  const idle = DashboardState.fromRun({
    state,
    events: [
      event(
        'unfinished-start',
        '2026-01-01T00:00:01.000Z',
        'agent_started',
        'implementer'
      ),
    ],
  })
  assert.equal(idle.epic.agentTimeMs, 0)
})

test('agent time uses the measured runAgent duration', () => {
  const state = createEpicState('/repo', 'epic')
  const dashboard = DashboardState.fromRun({
    state,
    events: [
      {
        id: 'start',
        epicId: state.epicId,
        timestamp: '2026-01-01T00:00:01.000Z',
        type: 'agent_started',
        stage: 'implementing',
        payload: { role: 'implementer', action: 'implementation' },
      },
      {
        id: 'finish',
        epicId: state.epicId,
        timestamp: '2026-01-01T00:00:10.000Z',
        type: 'agent_finished',
        stage: 'implementing',
        payload: {
          role: 'implementer',
          action: 'implementation',
          durationMs: 3_000,
        },
      },
    ],
  })

  assert.equal(dashboard.epic.agentTimeMs, 3_000)

  const active = DashboardState.fromRun({
    state,
    events: [],
    activeAgentRuns: [
      {
        startedAtMs: Date.parse('2026-01-01T00:00:05.000Z'),
      },
    ],
    now: '2026-01-01T00:00:08.000Z',
  })
  assert.equal(active.epic.agentTimeMs, 3_000)
})

test('action-required projection uses registered commands', () => {
  const state = createEpicState('/repo', 'epic')

  state.stage = 'awaiting_plan_review'
  const planReview = DashboardState.fromRun({
    state,
    events: [],
  }).actionRequired
  assert.equal(planReview?.id, 'plan-action-required')
  assert.deepEqual(
    planReview?.actions.map((item) => item.command),
    ['/plan-approve', '/epic-exit']
  )
  assert.deepEqual(
    planReview?.actions.map((item) => item.label),
    ['Continue', 'Exit']
  )
  assert.match(planReview?.message ?? '', /plan\.md/)
  assert.ok(planReview?.message?.includes('\x1b]8;;file:///repo/plan.md\x1b\\'))

  state.planRevision = 2
  const refinedPlan = DashboardState.fromRun({
    state,
    events: [],
  }).actionRequired
  assert.match(refinedPlan?.message ?? '', /plan\.md has been refined/)

  state.stage = 'awaiting_task_approval'
  const taskReview = DashboardState.fromRun({
    state,
    events: [],
  }).actionRequired
  assert.deepEqual(
    taskReview?.actions.map((item) => item.command),
    ['/task-approve', '/epic-exit']
  )
  assert.deepEqual(
    taskReview?.actions.map((item) => item.label),
    ['Continue', 'Exit']
  )
  assert.match(taskReview?.message ?? '', /task-001\.md/)
  assert.ok(
    taskReview?.message?.includes(
      `\x1b]8;;file:///repo/.pi/epics/runs/${state.epicId}/tasks/task-001.md\x1b\\`
    )
  )

  state.stage = 'awaiting_task_review'
  const implementationReview = DashboardState.fromRun({
    state,
    events: [],
  }).actionRequired
  assert.equal(implementationReview?.title, 'Task implementation completed')
  assert.match(
    implementationReview?.message ?? '',
    /Implemented .*task-001\.md.*Manually verify the acceptance criteria.*R:/
  )

  state.stage = 'awaiting_prerequisite_approval'
  const prerequisites = DashboardState.fromRun({
    state,
    events: [],
  }).actionRequired
  assert.deepEqual(
    prerequisites?.actions.map((item) => item.command),
    ['/epic-approve-prerequisites', '/epic-exit']
  )
  assert.deepEqual(
    prerequisites?.actions.map((item) => item.label),
    ['Approve prerequisites', 'Exit']
  )

  state.stage = 'escalating'
  state.failureReason = 'A retry is required.'
  const escalation = DashboardState.fromRun({
    state,
    events: [],
  }).actionRequired
  assert.equal(escalation?.severity, 'critical')
  assert.equal(escalation?.message, state.failureReason)
  assert.deepEqual(
    escalation?.actions.map((item) => item.label),
    ['Resume', 'Exit']
  )

  state.stage = 'implementing'
  assert.equal(
    DashboardState.fromRun({
      state,
      events: [],
    }).actionRequired,
    undefined
  )

  state.stage = 'decomposing_tasks'
  assert.equal(
    DashboardState.fromRun({
      state,
      events: [],
    }).actionRequired,
    undefined
  )
})

test('active operations suppress stale action requests and release on failure', async () => {
  const state = createEpicState('/repo', 'epic')
  state.stage = 'awaiting_plan_approval'

  await assert.rejects(
    withActiveEpicOperation(state.epicId, async () => {
      assert.equal(isEpicOperationActive(state.epicId), true)
      assert.equal(
        DashboardState.fromRun({
          state,
          events: [],
          activeOperation: isEpicOperationActive(state.epicId),
        }).actionRequired,
        undefined
      )
      throw new Error('operation failed')
    }),
    /operation failed/
  )

  assert.equal(isEpicOperationActive(state.epicId), false)
  assert.equal(
    DashboardState.fromRun({
      state,
      events: [],
      activeOperation: isEpicOperationActive(state.epicId),
    }).actionRequired?.id,
    'plan-action-required'
  )
})

test('registered epic commands remain the action projection command set', () => {
  const registered = new Set<string>()
  const api = {
    on: () => undefined,
    registerCommand: (name: string) => registered.add(name),
  } as unknown as ExtensionAPI

  epicExtension(api)

  assert.deepEqual(registered, new Set(Object.values(EPIC_COMMANDS)))
})
