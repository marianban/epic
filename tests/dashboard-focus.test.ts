import assert from 'node:assert/strict'
import test from 'node:test'
import type { Theme } from '@earendil-works/pi-coding-agent'
import type { TUI } from '@earendil-works/pi-tui'
import { EpicStatusWidget } from '../pi/extensions/epic/dashboard/widget-lifecycle.ts'
import type { DashboardState } from '../pi/extensions/epic/dashboard/state.ts'

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  inverse: (text: string) => text,
} as unknown as Theme

function dashboard(actionRequired: DashboardState['actionRequired'] = undefined): DashboardState {
  return {
    epic: {
      id: 'run',
      runDirectory: '/repo/.pi/epics/runs/run',
      name: 'Ship it',
      status: 'in-progress',
      agentTimeMs: 0,
      tasks: { completed: 0, total: 1, percent: 0 },
      criteria: { completed: 0, total: 1, percent: 0 },
      tokens: { total: 0 },
    },
    actionRequired,
    currentTask: {
      id: 'T1',
      index: 1,
      totalTasks: 1,
      name: 'Implement pipeline',
      status: 'in-progress',
      agentTimeMs: 0,
      attempt: { current: 1 },
      criteria: { completed: 0, total: 1, percent: 0 },
    },
    pipeline: {
      agents: [
        {
          role: 'scout',
          model: 'model-a',
          status: 'idle',
          runCount: 0,
          agentTimeMs: 0,
        },
      ],
      models: [
        {
          id: '[null,"model-a"]',
          model: 'model-a',
          thinkingLevels: [],
          roles: ['scout'],
          status: 'idle',
          runCount: 0,
          agentTimeMs: 0,
        },
      ],
    },
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function createWidget(
  load: () => Promise<DashboardState | undefined>
): { widget: EpicStatusWidget; input: (data: string) => { consume?: boolean } | undefined; renders: () => number } {
  let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined
  let renderRequests = 0
  const widget = new EpicStatusWidget(
    '/repo',
    { requestRender: () => { renderRequests++ } } as unknown as TUI,
    theme,
    async () => load(),
    () => undefined,
    () => undefined,
    (handler) => {
      inputHandler = handler
      return () => { inputHandler = undefined }
    },
    60_000
  )
  return {
    widget,
    input: (data) => inputHandler?.(data),
    renders: () => renderRequests,
  }
}

test('live dashboard composes Epic, Task, and Pipeline and cycles passive focus', async () => {
  const current = dashboard()
  const created = createWidget(async () => current)
  await new Promise<void>((resolve) => setImmediate(resolve))
  const first = created.widget.render(120).join('\n')
  assert.ok(first.indexOf('EPIC') < first.indexOf('TASK'))
  assert.ok(first.indexOf('TASK') < first.indexOf('PIPELINE'))

  created.input('\t')
  assert.match(created.widget.render(120).join('\n'), /Agent.*Model.*Thinking/)
  created.input('\t')
  assert.match(created.widget.render(120).join('\n'), /Provider.*Roles/)
  created.input('\t')
  assert.match(created.widget.render(120).join('\n'), /TASK/)
  assert.ok(created.renders() >= 3)
  created.widget.dispose()
})

test('pipeline selection survives refresh without reloading composition', async () => {
  let current = dashboard()
  const created = createWidget(async () => current)
  await new Promise<void>((resolve) => setImmediate(resolve))
  created.input('\t')
  created.input('\t')
  current = dashboard()
  await created.widget.refresh()
  assert.match(created.widget.render(120).join('\n'), /Provider.*Roles/)
  created.widget.dispose()
})

test('action-required focus owns input and no-active refresh clears Pipeline', async () => {
  let current: DashboardState | undefined = dashboard({
    id: 'checkpoint',
    severity: 'warning',
    title: 'Checkpoint',
    actions: [{ id: 'continue', label: 'Continue' }],
  })
  const created = createWidget(async () => current)
  await new Promise<void>((resolve) => setImmediate(resolve))
  const before = created.widget.render(120).join('\n')
  assert.ok(before.indexOf('TASK') < before.indexOf('CHECKPOINT'))
  assert.ok(before.indexOf('PIPELINE') < before.indexOf('CHECKPOINT'))
  const result = created.input('\t')
  assert.equal(result?.consume, true)
  assert.match(created.widget.render(120).join('\n'), /CHECKPOINT/)

  current = undefined
  await created.widget.refresh()
  assert.match(created.widget.render(80).join('\n'), /No active epic\./)
  assert.doesNotMatch(created.widget.render(80).join('\n'), /PIPELINE/)
  assert.equal(created.input('\t'), undefined)
  created.widget.dispose()
})
