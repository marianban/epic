import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Theme } from '@earendil-works/pi-coding-agent'
import type { TUI } from '@earendil-works/pi-tui'
import { visibleWidth } from '@earendil-works/pi-tui'
import { CurrentTask } from '../pi/extensions/epic/dashboard/components/current-task.ts'
import { DashboardState } from '../pi/extensions/epic/dashboard/state.ts'
import { createEpicState } from '../pi/extensions/epic/state.ts'
import type { EpicEvent, EpicTask } from '../pi/extensions/epic/types.ts'
import { EpicStatusWidget } from '../pi/extensions/epic/dashboard/widget-lifecycle.ts'

const identityTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  inverse: (text: string) => text,
} as unknown as Theme

function task(id: string, title: string, criteria = 3): EpicTask {
  return {
    id,
    title,
    objective: 'Complete the task.',
    scope: { read: [], modify: [], create: [], delete: [] },
    implementation: [],
    acceptanceCriteria: Array.from({ length: criteria }, () => 'criterion'),
    verification: [],
    manualReviewSteps: [],
    risks: [],
    requiredChecks: [],
    deferredChecks: [],
    reason: 'Needed.',
  }
}

function event(
  state: ReturnType<typeof createEpicState>,
  id: string,
  timestamp: string,
  type: string,
  payload: Record<string, unknown>,
  stage = state.stage
): EpicEvent {
  return { id, epicId: state.epicId, timestamp, type, stage, payload }
}

function taskDashboard() {
  const state = createEpicState('/repo', 'Epic', '2026-01-01T00:00:00.000Z')
  state.tasks = [task('task-001', 'First task'), task('task-002', 'Introduce Phaser game scene')]
  state.currentTaskIndex = 1
  state.stage = 'implementing'
  const events = [
    event(state, 'other-start', '2026-01-01T00:00:01.000Z', 'agent_started', {
      role: 'implementer',
      action: 'implementation',
      taskId: 'task-001',
    }),
    event(state, 'other-finish', '2026-01-01T00:00:02.000Z', 'agent_finished', {
      role: 'implementer',
      action: 'implementation',
      taskId: 'task-001',
      durationMs: 999_000,
    }),
    event(state, 'implementation-start', '2026-01-01T00:01:00.000Z', 'agent_started', {
      role: 'implementer',
      action: 'implementation',
      taskId: 'task-002',
    }),
    event(state, 'implementation-finish', '2026-01-01T00:02:40.000Z', 'agent_finished', {
      role: 'implementer',
      action: 'implementation',
      taskId: 'task-002',
      durationMs: 100_000,
    }),
    event(state, 'review-start', '2026-01-01T00:02:45.000Z', 'agent_started', {
      role: 'reviewer',
      action: 'semantic review',
      taskId: 'task-002',
    }),
    event(state, 'review-finish', '2026-01-01T00:03:20.000Z', 'agent_finished', {
      role: 'reviewer',
      action: 'semantic review',
      taskId: 'task-002',
      durationMs: 20_000,
    }),
    event(state, 'criteria', '2026-01-01T00:03:21.000Z', 'task_review_completed', {
      taskId: 'task-002',
      criteriaCompleted: 2,
      criteriaTotal: 3,
    }),
    event(state, 'diff', '2026-01-01T00:03:22.000Z', 'task_diff_updated', {
      taskId: 'task-002',
      filesChanged: 4,
      linesAdded: 182,
      linesDeleted: 43,
    }),
  ]
  return DashboardState.fromRun({
    state,
    events,
    activeAgentRuns: [
      {
        startedAtMs: Date.parse('2026-01-01T00:03:30.000Z'),
        taskId: 'task-002',
        role: 'reviewer',
      },
    ],
    now: '2026-01-01T00:03:50.000Z',
  })
}

test('projects task identity, task-scoped time, attempts, criteria, agent, and diff', () => {
  const dashboard = taskDashboard()
  assert.deepEqual(dashboard.currentTask, {
    id: 'task-002',
    index: 2,
    totalTasks: 2,
    name: 'Introduce Phaser game scene',
    status: 'in-progress',
    agentTimeMs: 140_000,
    attempt: { current: 1 },
    criteria: { completed: 2, total: 3, percent: (2 / 3) * 100 },
    agent: 'Reviewer',
    diff: {
      filesChanged: 4,
      linesAdded: 182,
      linesDeleted: 43,
    },
  })
})

test('current task is absent for epic-level and terminal operations', () => {
  const state = createEpicState('/repo', 'Epic')
  state.tasks = [task('task-001', 'Task')]
  for (const stage of ['planning', 'decomposing_tasks', 'completed', 'failed'] as const) {
    state.stage = stage
    assert.equal(
      DashboardState.fromRun({
        state,
        events: [],
        ...(stage === 'completed' || stage === 'failed'
          ? { completedAt: state.updatedAt }
          : {}),
      }).currentTask,
      undefined,
      stage
    )
  }
})

test('normalizes task workflow statuses', () => {
  const state = createEpicState('/repo', 'Epic')
  state.tasks = [task('task-001', 'Task')]
  for (const [stage, expected] of [
    ['awaiting_task_approval', 'initial-review'],
    ['revising_task', 'refinement'],
    ['implementing', 'in-progress'],
    ['awaiting_task_review', 'completed'],
    ['escalating', 'failed'],
  ] as const) {
    state.stage = stage
    if (stage === 'escalating') state.failureReason = 'Retry required.'
    assert.equal(
      DashboardState.fromRun({ state, events: [] }).currentTask?.status,
      expected,
      stage
    )
  }
})

test('renders the wide current task grid with aligned columns', () => {
  const currentTask = taskDashboard().currentTask
  assert.ok(currentTask)
  const lines = new CurrentTask(currentTask, identityTheme).render(100)
  const output = lines.join('\n')
  assert.match(output, /CURRENT TASK/)
  assert.match(output, /#2 {2}Introduce Phaser game scene/)
  assert.match(output, /● IN PROGRESS/)
  assert.match(output, /Time\s+02:20/)
  assert.match(output, /Agent\s+Reviewer/)
  assert.match(output, /Files\s+4 changed/)
  assert.match(output, /Diff\s+\+182 \/ -43/)
  const time = lines.find((line) => line.includes('Time'))
  const attempt = lines.find((line) => line.includes('Attempt'))
  const criteria = lines.find((line) => line.includes('Criteria'))
  assert.ok(time && attempt && criteria)
  assert.equal(time.indexOf('02:20'), attempt.indexOf('1'))
  assert.equal(time.indexOf('02:20'), criteria.indexOf('2 / 3'))
})

test('renders a readable single-column layout with placeholders', () => {
  const component = new CurrentTask(
    {
      id: 'task-001',
      index: 1,
      totalTasks: 1,
      name: 'A deliberately long task title that must remain readable',
      status: 'completed',
      agentTimeMs: 242_000,
      attempt: { current: 2 },
      criteria: { completed: 0, total: 6, percent: 0 },
    },
    identityTheme
  )
  const lines = component.render(32)
  const output = lines.join('\n')
  assert.match(output, /04:02/)
  assert.match(output, /Agent\s+--/)
  assert.match(output, /Files\s+--/)
  assert.match(output, /Diff\s+--/)
  assert.ok(lines.every((line) => visibleWidth(line) <= 32))
  assert.ok(lines.findIndex((line) => line.includes('Agent')) > lines.findIndex((line) => line.includes('Criteria')))
})

test('renders warning indicators without changing semantic diff values', () => {
  const component = new CurrentTask(
    {
      id: 'task-001',
      index: 1,
      totalTasks: 1,
      name: 'Task',
      status: 'failed',
      agentTimeMs: 0,
      attempt: { current: 1 },
      criteria: { completed: 0, total: 0, percent: 0 },
      diff: {
        filesChanged: 47,
        linesAdded: 0,
        linesDeleted: 2342,
        hasWarning: true,
      },
    },
    identityTheme
  )
  const output = component.render(100).join('\n')
  assert.match(output, /47 changed ⚠/)
  assert.match(output, /\+0 \/ -2342 ⚠/)
  assert.match(output, /✕ FAILED/)
})

test('dashboard lifecycle removes current task after workflow leaves task stages', async () => {
  const active = taskDashboard()
  const settledState = createEpicState('/repo', 'Epic')
  settledState.stage = 'idle'
  const settled = DashboardState.fromRun({ state: settledState, events: [] })
  const states = [active, settled]
  let index = 0
  const widget = new EpicStatusWidget(
    '/repo',
    { requestRender: () => undefined } as unknown as TUI,
    identityTheme,
    async () => states[Math.min(index++, states.length - 1)],
    () => undefined,
    () => undefined,
    () => () => undefined,
    60_000
  )
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.match(widget.render(100).join('\n'), /CURRENT TASK/)
  await widget.refresh()
  assert.doesNotMatch(widget.render(100).join('\n'), /CURRENT TASK/)
  widget.dispose()
})
