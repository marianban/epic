import assert from 'node:assert/strict'
import {
  appendFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type {
  ExtensionAPI,
  Theme,
} from '@earendil-works/pi-coding-agent'
import type { Component, TUI } from '@earendil-works/pi-tui'
import {
  EPIC_STATUS_WIDGET_KEY,
  EpicStatusWidget,
  registerEpicStatusWidget,
} from '../pi/extensions/epic/dashboard/widget-lifecycle.ts'
import { loadActiveDashboardState } from '../pi/extensions/epic/dashboard/data.ts'
import { DashboardState } from '../pi/extensions/epic/dashboard/state.ts'
import { createEpicState } from '../pi/extensions/epic/state.ts'
import { withActiveEpicOperation } from '../pi/extensions/epic/operation-status.ts'
import type { EpicTask } from '../pi/extensions/epic/types.ts'
import {
  appendEvent,
  loadActiveEpic,
  saveState,
} from '../pi/extensions/epic/persistence.ts'

const identityTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  inverse: (text: string) => text,
} as unknown as Theme

function task(): EpicTask {
  return {
    id: 'task-1',
    title: 'Task',
    objective: 'Do the task.',
    scope: { read: [], modify: [], create: [], delete: [] },
    implementation: [],
    acceptanceCriteria: ['criterion'],
    verification: [],
    manualReviewSteps: [],
    risks: [],
    requiredChecks: ['typecheck'],
    deferredChecks: [],
    reason: 'Needed.',
  }
}

async function createDashboardFixture(): Promise<{
  root: string
  eventsPath: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'pi-epic-status-'))
  const state = createEpicState(root, 'Live epic', '2026-01-01T00:00:00.000Z')
  state.tasks = [task(), task()]
  state.currentTaskIndex = 1
  const eventsPath = join(
    root,
    '.pi',
    'epics',
    'runs',
    state.epicId,
    'events.jsonl'
  )
  await saveState(state)
  await appendEvent(state, 'agent_started', {
    role: 'implementer',
    action: 'implementation',
  })
  await appendEvent(state, 'agent_finished', {
    role: 'implementer',
    action: 'implementation',
    usage: { inputTokens: 100, outputTokens: 25 },
  })
  return { root, eventsPath }
}

test('dashboard loader feeds the projection from persisted epic data', async () => {
  const fixture = await createDashboardFixture()
  try {
    const dashboard = await loadActiveDashboardState(
      fixture.root,
      new Date().toISOString()
    )

    assert.ok(dashboard)
    assert.equal(dashboard.epic.name, 'Live epic')
    assert.equal(dashboard.epic.tasks.completed, 1)
    assert.equal(dashboard.epic.tasks.total, 2)
    assert.deepEqual(dashboard.epic.tokens, {
      total: 125,
      input: 100,
      output: 25,
    })
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('dashboard loader returns no active dashboard without an active pointer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-epic-status-empty-'))
  try {
    assert.equal(
      await loadActiveDashboardState(root, new Date().toISOString()),
      undefined
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('dashboard loader uses persisted updatedAt for terminal completion time', async () => {
  const fixture = await createDashboardFixture()
  try {
    const state = await loadActiveEpic(fixture.root)
    const statePath = join(
      fixture.root,
      '.pi',
      'epics',
      'runs',
      state.epicId,
      'state.json'
    )
    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as {
      stage: string
      updatedAt: string
      machineSnapshot: {
        value: unknown
        context: { state: Record<string, unknown> }
      }
    }
    persisted.stage = 'cancelled'
    persisted.updatedAt = '2026-01-01T00:00:05.000Z'
    persisted.machineSnapshot.value = { terminal: 'cancelled' }
    persisted.machineSnapshot.context.state = {
      ...persisted.machineSnapshot.context.state,
      stage: 'cancelled',
      updatedAt: persisted.updatedAt,
    }
    await writeFile(statePath, `${JSON.stringify(persisted)}\n`)

    const loaded = await loadActiveEpic(fixture.root)
    const dashboard = await loadActiveDashboardState(
      fixture.root,
      new Date().toISOString()
    )
    assert.ok(dashboard)
    assert.equal(dashboard.epic.status, 'failed')
    assert.equal(dashboard.epic.completedAt, loaded.updatedAt)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('dashboard loader rejects malformed event data', async () => {
  const fixture = await createDashboardFixture()
  try {
    await appendFile(fixture.eventsPath, '{not-json}\n')
    await assert.rejects(
      () =>
        loadActiveDashboardState(fixture.root, new Date().toISOString()),
      /Invalid event journal entry/
    )
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('dashboard loader hides stale approval while a slash-command operation is active', async () => {
  const fixture = await createDashboardFixture()
  try {
    const state = await loadActiveEpic(fixture.root)
    const statePath = join(
      fixture.root,
      '.pi',
      'epics',
      'runs',
      state.epicId,
      'state.json'
    )
    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as {
      stage: string
      pendingHumanAction: string
      machineSnapshot: {
        value: unknown
        context: { state: Record<string, unknown> }
      }
    }
    persisted.stage = 'awaiting_plan_approval'
    persisted.pendingHumanAction = 'approve_plan'
    persisted.machineSnapshot.value = { planning: 'awaitingApproval' }
    persisted.machineSnapshot.context.state = {
      ...persisted.machineSnapshot.context.state,
      stage: 'awaiting_plan_approval',
      pendingHumanAction: 'approve_plan',
    }
    await writeFile(statePath, `${JSON.stringify(persisted)}\n`)

    const hidden = await withActiveEpicOperation(state.epicId, () =>
      loadActiveDashboardState(fixture.root, new Date().toISOString())
    )
    assert.ok(hidden)
    assert.equal(hidden.actionRequired, undefined)

    const visible = await loadActiveDashboardState(
      fixture.root,
      new Date().toISOString()
    )
    assert.equal(visible?.actionRequired?.id, 'plan-action-required')
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('live widget updates its EpicStats and requests a redraw', async () => {
  const firstState = createEpicState('/repo', 'First epic')
  const secondState = createEpicState('/repo', 'Second epic')
  const states = [
    DashboardState.fromRun({
      state: firstState,
      events: [],
    }),
    DashboardState.fromRun({
      state: secondState,
      events: [],
    }),
  ]
  let index = 0
  let redraws = 0
  const tui = { requestRender: () => redraws++ } as unknown as TUI
  const widget = new EpicStatusWidget(
    '/repo',
    tui,
    identityTheme,
    async () => states[Math.min(index++, states.length - 1)],
    () => undefined,
    () => undefined,
    () => () => undefined,
    60_000
  )

  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.match(widget.render(100).join('\n'), /First epic/)
  await widget.refresh()
  assert.match(widget.render(100).join('\n'), /Second epic/)
  assert.ok(redraws >= 2)
  widget.dispose()
})

test('live widget renders an empty state without an active epic', async () => {
  let redraws = 0
  const tui = { requestRender: () => redraws++ } as unknown as TUI
  const widget = new EpicStatusWidget(
    '/repo',
    tui,
    identityTheme,
    async () => undefined,
    () => undefined,
    () => undefined,
    () => () => undefined,
    60_000
  )

  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.match(widget.render(100).join('\n'), /No active epic\./)
  assert.ok(redraws >= 1)
  widget.dispose()
})

test('live widget renders and dispatches the focused action', async () => {
  const actionState = createEpicState('/repo', 'Action epic')
  actionState.stage = 'awaiting_plan_review'
  const settledState = createEpicState('/repo', 'Action epic')
  settledState.stage = 'implementing'
  const states = [
    DashboardState.fromRun({ state: actionState, events: [] }),
    DashboardState.fromRun({ state: settledState, events: [] }),
  ]
  let index = 0
  let redraws = 0
  let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined
  let dispatched: string | undefined
  const widget = new EpicStatusWidget(
    '/repo',
    { requestRender: () => redraws++ } as unknown as TUI,
    identityTheme,
    async () => states[Math.min(index++, states.length - 1)],
    () => undefined,
    (action) => {
      dispatched = action.id
    },
    (handler) => {
      inputHandler = handler
      return () => {
        inputHandler = undefined
      }
    },
    60_000
  )

  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.match(widget.render(100).join('\n'), /ACTION REQUIRED/)
  assert.equal(inputHandler?.('\x1b[C')?.consume, true)
  assert.equal(inputHandler?.('\x1b[1;1:3C')?.consume, true)
  assert.equal(inputHandler?.('\r')?.consume, true)
  assert.equal(dispatched, 'epic-cancel')

  await widget.refresh()
  assert.doesNotMatch(widget.render(100).join('\n'), /ACTION REQUIRED/)
  assert.ok(redraws >= 2)
  widget.dispose()
  assert.equal(inputHandler, undefined)
})

test('live widget reappears when active execution reaches task approval', async () => {
  const busyState = createEpicState('/repo', 'Action epic')
  busyState.stage = 'awaiting_plan_approval'
  const readyState = createEpicState('/repo', 'Action epic')
  readyState.stage = 'awaiting_task_approval'
  const states = [
    DashboardState.fromRun({
      state: busyState,
      events: [],
      activeOperation: true,
    }),
    DashboardState.fromRun({ state: readyState, events: [] }),
  ]
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
  assert.doesNotMatch(widget.render(100).join('\n'), /ACTION REQUIRED/)
  await widget.refresh()
  assert.match(widget.render(100).join('\n'), /ACTION REQUIRED/)
  widget.dispose()
})

test('lifecycle registers and clears the TUI epicstatus widget', () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>()
  const api = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) =>
      handlers.set(event, handler),
  } as unknown as ExtensionAPI
  registerEpicStatusWidget(api, 1_000, async () => undefined)

  let widgetKey: string | undefined
  let widgetContent: string[] | ((tui: TUI, theme: Theme) => Component) | undefined
  const setWidget = (
    key: string,
    content:
      | string[]
      | ((tui: TUI, theme: Theme) => Component)
      | undefined
  ) => {
    widgetKey = key
    widgetContent = content
  }
  const ctx = {
    mode: 'tui',
    cwd: '/repo',
    ui: { setWidget, notify: () => undefined },
  }

  handlers.get('session_start')?.({}, ctx)
  assert.equal(widgetKey, EPIC_STATUS_WIDGET_KEY)
  assert.equal(typeof widgetContent, 'function')

  handlers.get('session_shutdown')?.({}, ctx)
  assert.equal(widgetKey, EPIC_STATUS_WIDGET_KEY)
  assert.equal(widgetContent, undefined)
})
