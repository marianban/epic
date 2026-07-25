import assert from 'node:assert/strict'
import { test } from 'node:test'
import { visibleWidth } from '@earendil-works/pi-tui'
import type { Theme } from '@earendil-works/pi-coding-agent'
import { EpicStats } from '../pi/extensions/epic/dashboard/components/epic-stats.ts'
import { DashboardState } from '../pi/extensions/epic/dashboard/state.ts'
import { createEpicState } from '../pi/extensions/epic/state.ts'
import type { EpicTask } from '../pi/extensions/epic/types.ts'

const identityTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme

function task(index: number): EpicTask {
  return {
    id: 'task-1',
    title: 'Task',
    objective: 'Do the task.',
    scope: { read: [], modify: [], create: [], delete: [] },
    implementation: [],
    acceptanceCriteria: Array.from({ length: index < 4 ? 5 : 4 }, () => 'criterion'),
    verification: [],
    manualReviewSteps: [],
    risks: [],
    requiredChecks: index < 7 ? ['typecheck', 'lint', 'test'] : ['typecheck', 'lint'],
    deferredChecks: [],
    reason: 'Needed.',
  }
}

function dashboard(name = 'Arkanoid Phaser Migration'): DashboardState {
  const state = createEpicState('/repo', name, '2026-01-01T00:00:00.000Z')
  state.epicId = '20260724164024-b3195daa'
  state.stage = 'escalating'
  state.failureReason = 'A retry is required.'
  state.tasks = Array.from({ length: 9 }, (_, index) => task(index))
  state.currentTaskIndex = 2
  state.implementationAttempt = 1
  state.fastRepairAttempt = 0
  state.fullRepairAttempt = 0
  state.semanticRepairAttempt = 0
  return DashboardState.fromRun({
    state,
    events: [
      {
        id: 'agent-start',
        epicId: state.epicId,
        timestamp: '2026-01-01T00:00:01.000Z',
        type: 'agent_started',
        stage: 'implementing',
        payload: { role: 'implementer', action: 'implementation' },
      },
      {
        id: 'agent-finish',
        epicId: state.epicId,
        timestamp: '2026-01-01T00:06:49.000Z',
        type: 'agent_finished',
        stage: 'implementing',
        payload: {
          role: 'implementer',
          action: 'implementation',
          usage: { totalTokens: 43_800 },
        },
      },
    ],
    checkResults: [],
  })
}

test('renders the wide epic stats layout and representative metrics', () => {
  const lines = new EpicStats(dashboard(), identityTheme).render(100)
  const output = lines.join('\n')

  assert.match(output, /EPIC/)
  assert.match(output, /Arkanoid Phaser Migration ⚠ ESCALATING/)
  assert.match(output, /20260724164024-b3195daa/)
  const taskLine = lines.find((line) => line.includes('Tasks'))
  const criteriaLine = lines.find((line) => line.includes('Criteria'))
  const checksLine = lines.find((line) => line.includes('Checks'))
  assert.ok(taskLine)
  assert.ok(criteriaLine)
  assert.ok(checksLine)
  assert.equal(
    taskLine.indexOf('2 / 9') + '2 / 9'.length,
    criteriaLine.indexOf('0 / 40') + '0 / 40'.length
  )
  assert.equal(
    taskLine.indexOf('2 / 9') + '2 / 9'.length,
    checksLine.indexOf('0 / 25') + '0 / 25'.length
  )
  assert.equal(taskLine.search(/[█░]/), criteriaLine.search(/[█░]/))
  assert.equal(taskLine.search(/[█░]/), checksLine.search(/[█░]/))
  assert.equal(
    taskLine.lastIndexOf('22%') + '22%'.length,
    criteriaLine.lastIndexOf('0%') + '0%'.length
  )
  assert.equal(
    taskLine.lastIndexOf('22%') + '22%'.length,
    checksLine.lastIndexOf('0%') + '0%'.length
  )
  assert.match(taskLine, /Agent time 06:48 │$/)
  assert.doesNotMatch(criteriaLine, /Agent time/)
  assert.doesNotMatch(checksLine, /Agent time/)
  assert.match(output, /Tokens 43.8k Attempts 1 impl \/ 0 fix/)
})

test('uses compact rendering below the fixed breakpoint', () => {
  const lines = new EpicStats(dashboard(), identityTheme).render(60)

  assert.equal(lines.length, 9)
  const taskLine = lines.find((line) => line.includes('Tasks'))
  const criteriaLine = lines.find((line) => line.includes('Criteria'))
  const checksLine = lines.find((line) => line.includes('Checks'))
  assert.ok(taskLine)
  assert.ok(criteriaLine)
  assert.ok(checksLine)
  assert.equal(
    taskLine.indexOf('2 / 9') + '2 / 9'.length,
    criteriaLine.indexOf('0 / 40') + '0 / 40'.length
  )
  assert.equal(
    taskLine.indexOf('2 / 9') + '2 / 9'.length,
    checksLine.indexOf('0 / 25') + '0 / 25'.length
  )
  assert.equal(taskLine.search(/[█░]/), criteriaLine.search(/[█░]/))
  assert.equal(taskLine.search(/[█░]/), checksLine.search(/[█░]/))
  assert.match(taskLine, /Agent time 06:48 │$/)
  assert.doesNotMatch(criteriaLine, /Agent time/)
  assert.doesNotMatch(checksLine, /Agent time/)
})

test('updates output after an explicit state replacement', () => {
  const first = dashboard('First epic')
  const component = new EpicStats(first, identityTheme)
  assert.match(component.render(100).join('\n'), /First epic/)

  component.setState(dashboard('Second epic'))
  assert.match(component.render(100).join('\n'), /Second epic/)
  assert.doesNotMatch(component.render(100).join('\n'), /First epic/)
})

test('truncates long labels and keeps every line within the requested width', () => {
  const lines = new EpicStats(
    dashboard('A very long epic name that must be truncated to fit the terminal'),
    identityTheme
  ).render(32)

  assert.ok(lines.some((line) => line.includes('…')))
  assert.ok(lines.every((line) => visibleWidth(line) <= 32))
})

test('uses semantic theme colors for dashboard statuses', () => {
  const colors: string[] = []
  const theme = {
    fg: (color: string, text: string) => {
      colors.push(color)
      return text
    },
    bold: (text: string) => text,
  } as unknown as Theme

  const cases = [
    ['completed', 'success'],
    ['failed', 'error'],
    ['awaiting_plan_review', 'warning'],
    ['implementing', 'accent'],
  ] as const

  for (const [stage, expectedColor] of cases) {
    const state = createEpicState('/repo', 'Status test')
    state.stage = stage
    const dashboardState = DashboardState.fromRun({
      state,
      events: [],
      checkResults: [],
      ...(stage === 'completed' || stage === 'failed'
        ? { completedAt: state.updatedAt }
        : {}),
    })
    colors.length = 0
    new EpicStats(dashboardState, theme).render(100)
    assert.ok(colors.includes(expectedColor), `${stage} should use ${expectedColor}`)
  }
})
