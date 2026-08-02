import assert from 'node:assert/strict'
import test from 'node:test'
import type { Theme } from '@earendil-works/pi-coding-agent'
import { CurrentTask } from '../pi/extensions/epic/dashboard/components/current-task.ts'
import { formatDuration } from '../pi/extensions/epic/dashboard/formatting.ts'
import type { CurrentTaskDashboardState } from '../pi/extensions/epic/dashboard/types.ts'

const identityTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  inverse: (text: string) => text,
} as unknown as Theme
test('current task duration formatter is stable', () => {
  assert.equal(formatDuration(65_000), '01:05')
})

test('current task panel uses the concise Task label', () => {
  const state: CurrentTaskDashboardState = {
    id: 'task-1',
    index: 1,
    totalTasks: 1,
    name: 'Implement it',
    status: 'in-progress',
    agentTimeMs: 65_000,
    attempt: { current: 1 },
    criteria: { completed: 0, total: 1, percent: 0 },
  }

  const output = new CurrentTask(state, identityTheme).render(80).join('\n')
  assert.match(output, /TASK/)
  assert.doesNotMatch(output, /CURRENT TASK/)
})
