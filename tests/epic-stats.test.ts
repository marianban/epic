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

function stripTerminalControls(value: string): string {
  const escape = String.fromCharCode(27)
  const sequenceStart = `${escape}]8;;`
  const sequenceEnd = `${escape}\\`
  let result = ''
  let cursor = 0
  while (cursor < value.length) {
    const start = value.indexOf(sequenceStart, cursor)
    if (start === -1) return result + value.slice(cursor)
    result += value.slice(cursor, start)
    const end = value.indexOf(sequenceEnd, start + sequenceStart.length)
    if (end === -1) return result + value.slice(start)
    cursor = end + sequenceEnd.length
  }
  return result
}

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
  })
}

test('renders the wide epic stats layout and representative metrics', () => {
  const lines = new EpicStats(dashboard(), identityTheme).render(100)
  const output = lines.join('\n')
  const visibleOutput = stripTerminalControls(output)

  assert.match(output, /EPIC/)
  assert.match(visibleOutput, /Prompt: Arkanoid Phaser Migration/)
  assert.match(visibleOutput, /Run ID: 20260724164024-b3195daa/)
  assert.doesNotMatch(visibleOutput, /ESCALATING/)
  const escape = String.fromCharCode(27)
  assert.ok(
    output.includes(
      `${escape}]8;;file:///repo/.pi/epics/runs/20260724164024-b3195daa${escape}\\`
    )
  )
  const taskLine = lines.find((line) => line.includes('Tasks'))
  const criteriaLine = lines.find((line) => line.includes('Criteria'))
  assert.ok(taskLine)
  assert.ok(criteriaLine)
  assert.equal(
    taskLine.indexOf('2 / 9') + '2 / 9'.length,
    criteriaLine.indexOf('10 / 40') + '10 / 40'.length
  )
  assert.equal(taskLine.search(/[█░]/), criteriaLine.search(/[█░]/))
  assert.equal(
    taskLine.lastIndexOf('22%') + '22%'.length,
    criteriaLine.lastIndexOf('25%') + '25%'.length
  )
  assert.match(taskLine, /Agent time 06:48 │$/)
  assert.doesNotMatch(criteriaLine, /Agent time/)
  assert.match(output, /Tokens 43.8k Attempts 1 impl \/ 0 fix/)
})

test('uses compact rendering below the fixed breakpoint', () => {
  const lines = new EpicStats(dashboard(), identityTheme).render(60)

  assert.equal(lines.length, 8)
  const taskLine = lines.find((line) => line.includes('Tasks'))
  const criteriaLine = lines.find((line) => line.includes('Criteria'))
  assert.ok(taskLine)
  assert.ok(criteriaLine)
  assert.equal(
    taskLine.indexOf('2 / 9') + '2 / 9'.length,
    criteriaLine.indexOf('10 / 40') + '10 / 40'.length
  )
  assert.equal(taskLine.search(/[█░]/), criteriaLine.search(/[█░]/))
  assert.match(taskLine, /Agent time 06:48 │$/)
  assert.doesNotMatch(criteriaLine, /Agent time/)
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
