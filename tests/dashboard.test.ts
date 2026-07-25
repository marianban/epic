import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DashboardState } from '../pi/extensions/epic/dashboard/state.ts'
import { createEpicState } from '../pi/extensions/epic/state.ts'
import type { EpicTask } from '../pi/extensions/epic/types.ts'

function task(
  overrides: Partial<Pick<EpicTask, 'acceptanceCriteria' | 'requiredChecks' | 'deferredChecks'>> = {}
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

test('task, attempts, and timing values use independent sources', () => {
  const state = createEpicState('/repo', 'epic', '2026-01-01T00:00:00.000Z')
  state.tasks = [
    task({ acceptanceCriteria: ['a', 'b'], requiredChecks: ['typecheck'] }),
    task({ acceptanceCriteria: ['c'], deferredChecks: ['tests'] }),
    task({ acceptanceCriteria: ['d'], requiredChecks: ['lint'] }),
  ]
  state.currentTaskIndex = 1
  state.implementationAttempt = 1
  state.fastRepairAttempt = 2
  state.fullRepairAttempt = 1
  state.semanticRepairAttempt = 3

  const dashboard = DashboardState.fromRun({
    state,
    events: [],
  })

  assert.equal(dashboard.epic.tasks.completed, 1)
  assert.equal(dashboard.epic.criteria.completed, 2)
  assert.equal(dashboard.epic.criteria.total, 4)
  assert.equal(dashboard.epic.agentTimeMs, 0)
  assert.deepEqual(dashboard.epic.attempts, { implementation: 1, repair: 6 })
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
      event('stale-start', '2026-01-01T00:00:01.000Z', 'agent_started', 'planner'),
      event('real-start', '2026-01-01T00:00:05.000Z', 'agent_started', 'planner'),
      event('real-finish', '2026-01-01T00:00:08.000Z', 'agent_finished', 'planner'),
      event('other-start', '2026-01-01T00:00:04.000Z', 'agent_started', 'scout'),
      event('other-finish', '2026-01-01T00:00:10.000Z', 'agent_finished', 'scout'),
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
    activeAgentRuns: [{
      startedAtMs: Date.parse('2026-01-01T00:00:05.000Z'),
    }],
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
  assert.equal(planReview?.id, 'plan-review-required')
  assert.deepEqual(
    planReview?.actions.map((item) => item.command),
    ['/plan-review', '/plan-approve', '/epic-cancel']
  )

  state.stage = 'awaiting_task_approval'
  const taskReview = DashboardState.fromRun({
    state,
    events: [],
  }).actionRequired
  assert.deepEqual(
    taskReview?.actions.map((item) => item.command),
    ['/task-review', '/task-approve', '/epic-cancel']
  )

  state.stage = 'escalating'
  state.failureReason = 'A retry is required.'
  const escalation = DashboardState.fromRun({
    state,
    events: [],
  }).actionRequired
  assert.equal(escalation?.severity, 'critical')
  assert.equal(escalation?.message, state.failureReason)

  state.stage = 'implementing'
  assert.equal(
    DashboardState.fromRun({
      state,
      events: [],
    }).actionRequired,
    undefined
  )
})
