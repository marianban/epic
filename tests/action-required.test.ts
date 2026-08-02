import assert from 'node:assert/strict'
import { test } from 'node:test'
import { visibleWidth } from '@earendil-works/pi-tui'
import type { Theme } from '@earendil-works/pi-coding-agent'
import { ActionRequired } from '../pi/extensions/epic/dashboard/components/action-required.ts'
import { humanContinuation } from '../pi/extensions/epic/human-actions.ts'
import type {
  DashboardAction,
  DashboardActionRequest,
} from '../pi/extensions/epic/dashboard/types.ts'

const identityTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  inverse: (text: string) => text,
} as unknown as Theme

const continueAction: DashboardAction = {
  id: 'continue',
  label: 'Continue',
  kind: 'primary',
  command: '/continue',
}
const exitAction: DashboardAction = {
  id: 'exit',
  label: 'Exit',
  kind: 'secondary',
  command: '/epic-exit',
}
const actions: readonly DashboardAction[] = [continueAction, exitAction]

function request(
  overrides: Partial<DashboardActionRequest> = {}
): DashboardActionRequest {
  return {
    id: 'plan-action-required',
    severity: 'warning',
    title: 'Plan is ready',
    actions,
    ...overrides,
  }
}

test('renders severity, title, message, and every action', () => {
  const component = new ActionRequired(
    request({ message: 'Please inspect the generated plan.' }),
    identityTheme,
    () => undefined
  )

  const output = component.render(100).join('\n')
  assert.match(output, /ACTION REQUIRED/)
  assert.match(output, /⚠ Plan is ready/)
  assert.match(output, /Please inspect the generated plan\./)
  for (const action of actions) assert.match(output, new RegExp(action.label))
  assert.match(output, /▸\[ Continue \]/)
})

test('Continue chooses approval or refinement from R: comments', () => {
  assert.equal(humanContinuation('# Plan\nNo review comments.'), 'approve')
  assert.equal(humanContinuation('# Plan\nR: clarify the rollout.'), 'review')
  assert.equal(
    humanContinuation('Keep this line. R: refine the acceptance criteria.'),
    'review'
  )
})

test('task review artifact without R: comments continues to approval', () => {
  assert.equal(
    humanContinuation(
      '# Task 1: Implement the feature\n\n## Human Review Instructions\n'
    ),
    'approve'
  )
})

test('renders the semantic icon for each severity', () => {
  for (const [severity, icon] of [
    ['info', '●'],
    ['warning', '⚠'],
    ['critical', '✕'],
  ] as const) {
    const output = new ActionRequired(
      request({ severity }),
      identityTheme,
      () => undefined
    )
      .render(80)
      .join('\n')
    assert.match(output, new RegExp(`${icon} Plan is ready`))
  }
})

test('renders no panel when action state is absent', () => {
  const component = new ActionRequired(
    undefined,
    identityTheme,
    () => undefined
  )
  assert.deepEqual(component.render(80), [])
})

test('navigates with wrapping in both directions', () => {
  const component = new ActionRequired(
    request(),
    identityTheme,
    () => undefined
  )
  assert.equal(component.getFocusedActionId(), 'continue')

  component.handleInput('\t')
  assert.equal(component.getFocusedActionId(), 'exit')
  component.handleInput('\x1b[C')
  assert.equal(component.getFocusedActionId(), 'continue')
  component.handleInput('\x1b[Z')
  assert.equal(component.getFocusedActionId(), 'exit')
  component.handleInput('\x1b[D')
  assert.equal(component.getFocusedActionId(), 'continue')
})

test('executes the focused action once on Enter', () => {
  const selected: DashboardAction[] = []
  const component = new ActionRequired(request(), identityTheme, (action) =>
    selected.push(action)
  )

  component.handleInput('\r')
  assert.deepEqual(
    selected.map((action) => action.id),
    ['continue']
  )
  assert.deepEqual(component.render(80), [])
})

test('preserves focus by action id and falls back when removed', () => {
  const component = new ActionRequired(
    request(),
    identityTheme,
    () => undefined
  )
  component.handleInput('\t')
  component.setState(request({ actions: [exitAction, continueAction] }))
  assert.equal(component.getFocusedActionId(), 'exit')

  component.setState(request({ actions: [continueAction] }))
  assert.equal(component.getFocusedActionId(), 'continue')
})

test('handles an empty action collection safely', () => {
  let executions = 0
  const component = new ActionRequired(
    request({ title: 'Manual intervention required', actions: [] }),
    identityTheme,
    () => executions++
  )

  const output = component.render(60).join('\n')
  assert.match(output, /Manual intervention required/)
  assert.doesNotMatch(output, /▸\[/)
  component.handleInput('\r')
  assert.equal(executions, 0)
})

test('wraps action controls and messages without clipping', () => {
  const component = new ActionRequired(
    request({
      message: 'This message is deliberately long enough to wrap across lines.',
      actions: [
        { id: 'one', label: 'First action', command: '/one' },
        { id: 'two', label: 'Second action', command: '/two' },
        { id: 'three', label: 'Third action', command: '/three' },
      ],
    }),
    identityTheme,
    () => undefined
  )

  const lines = component.render(30)
  const output = lines.join('\n')
  assert.match(output, /First action/)
  assert.match(output, /Second action/)
  assert.match(output, /Third action/)
  assert.ok(lines.every((line) => visibleWidth(line) <= 30))
})
