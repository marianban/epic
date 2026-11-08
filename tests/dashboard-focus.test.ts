import assert from 'node:assert/strict'
import test from 'node:test'
import type { Theme } from '@earendil-works/pi-coding-agent'
import { Container, Text, visibleWidth, type Component, type TUI, type TuiMouseEvent } from '@earendil-works/pi-tui'
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
): { widget: EpicStatusWidget; input: (data: string) => { consume?: boolean } | undefined; renders: () => number; terminal: { rows: number }; editor: Container; setFullscreen: () => void } {
  let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined
  let renderRequests = 0
  const terminal = { rows: 40 }
  const tui = { mode: 'regular', terminal, children: [] as Component[], requestRender: () => { renderRequests++ } }
  const widget = new EpicStatusWidget(
    '/repo',
    tui as unknown as TUI,
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
  const widgets = new Container()
  widgets.addChild({ render: () => [''], invalidate: () => undefined })
  widgets.addChild(widget)
  const editor = new Container()
  editor.addChild(new Text('prompt\ninput\nborder', 0, 0))
  tui.children = [new Text('transcript', 0, 0), widgets, editor, new Text('footer\nstatus', 0, 0)]
  return {
    widget,
    input: (data) => inputHandler?.(data),
    renders: () => renderRequests,
    terminal,
    editor,
    setFullscreen: () => { tui.mode = 'fullscreen' },
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
    verificationStatus: 'Final verification pending. The time allowance was exhausted.',
    actions: [{ id: 'continue', label: 'Continue' }],
  })
  const created = createWidget(async () => current)
  await new Promise<void>((resolve) => setImmediate(resolve))
  const before = created.widget.render(120).join('\n')
  assert.match(before, /Final verification pending/)
  assert.match(before, /time allowance was exhausted/)
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

function wheel(delta: number): TuiMouseEvent {
  return {
    type: 'wheel', button: 'none', wheelDelta: delta,
    x: 2, y: 2, screenX: 2, screenY: 2, width: 80, height: 20,
    shift: false, alt: false, ctrl: false,
  }
}

test('fullscreen dashboard scrolls through pi inline containers and retains position on refresh', async () => {
  const created = createWidget(async () => dashboard())
  try {
    created.setFullscreen()
    created.terminal.rows = 20
    await new Promise<void>((resolve) => setImmediate(resolve))
    const container = new Container()
    container.addChild(created.widget)
    const initial = container.render(80)
    assert.equal(initial.length, 13)
    assert.ok(initial.every((line) => visibleWidth(line) <= 80))
    assert.match(initial.at(-1) ?? '', /Alt\+PgUp\/PgDn/)

    assert.equal(container.handleMouse(wheel(10))?.handled, true)
    const scrolled = container.render(80).join('\n')
    assert.notEqual(scrolled, initial.join('\n'))
    await created.widget.refresh()
    assert.equal(container.render(80).join('\n'), scrolled)

    assert.equal(created.input('\u001b[1;3H')?.consume, true)
    assert.match(container.render(80).join('\n'), /EPIC/)
    assert.equal(created.input('\u001b[6;3~')?.consume, true)
    assert.doesNotMatch(container.render(80).join('\n'), /EPIC/)
    assert.equal(created.input('\u001b[5;3~')?.consume, true)
    assert.match(container.render(80).join('\n'), /EPIC/)
    assert.equal(created.input('\u001b[1;3F')?.consume, true)
    assert.match(container.render(80).join('\n'), /PIPELINE/)
    // Ordinary PageUp remains available to pi's transcript.
    assert.equal(created.input('\u001b[5~'), undefined)

    created.terminal.rows = 12
    const resized = container.render(35)
    assert.equal(resized.length, 5)
    assert.ok(resized.every((line) => visibleWidth(line) <= 35))
    created.terminal.rows = 200
    assert.match(container.render(120).join('\n'), /EPIC/)
    assert.doesNotMatch(container.render(120).join('\n'), /Alt\+PgUp/)
    assert.equal(container.render(120).length, 193)
  } finally {
    created.widget.dispose()
  }
})

test('fullscreen dashboard yields height as the prompt grows and releases space without an active epic', async () => {
  let current: DashboardState | undefined = dashboard()
  const created = createWidget(async () => current)
  try {
    created.setFullscreen()
    created.terminal.rows = 30
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(created.widget.render(80).length, 23)
    created.editor.addChild(new Text('extra prompt line\nqueued input', 0, 0))
    assert.equal(created.widget.render(80).length, 21)
    created.editor.clear()
    created.editor.addChild(new Text('prompt\ninput\nborder', 0, 0))
    assert.equal(created.widget.render(80).length, 23)
    current = undefined
    await created.widget.refresh()
    assert.equal(created.widget.render(80).length, 1)
    assert.match(created.widget.render(80)[0], /No active epic/)
  } finally {
    created.widget.dispose()
  }
})

test('fullscreen reveals keyboard focus and new checkpoints without resetting manual scrolling', async () => {
  let current = dashboard()
  const created = createWidget(async () => current)
  try {
    created.setFullscreen()
    created.terminal.rows = 20
    await new Promise<void>((resolve) => setImmediate(resolve))
    created.widget.render(80)
    created.input('\t')
    assert.match(created.widget.render(80).join('\n'), /PIPELINE/)
    current = dashboard({
      id: 'checkpoint', severity: 'warning', title: 'Checkpoint',
      manualReviewSteps: Array.from({ length: 30 }, (_, index) => `Review step ${index + 1}`),
      actions: [{ id: 'continue', label: 'Continue' }],
    })
    await created.widget.refresh()
    assert.match(created.widget.render(80).join('\n'), /Continue/)
    created.widget.handleMouse(wheel(-5))
    const scrolled = created.widget.render(80).join('\n')
    await created.widget.refresh()
    assert.equal(created.widget.render(80).join('\n'), scrolled)
    created.input('\t')
    assert.match(created.widget.render(80).join('\n'), /Continue/)
  } finally {
    created.widget.dispose()
  }
})
