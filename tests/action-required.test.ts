import type { ManualReview } from '../pi/extensions/epic/verification-types.ts'
import { editManualReviewItem } from '../pi/extensions/epic/dashboard/manual-review-editor.ts'
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
  bg: (_color: string, text: string) => text,
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
  assert.match(output, /CHECKPOINT/)
  assert.match(output, /⚠ Plan is ready/)
  assert.match(output, /Please inspect the generated plan\./)
  for (const action of actions) assert.match(output, new RegExp(action.label))
  assert.match(output, /▸\[ Continue \]/)
})

test('renders manual review steps before the report link and checkpoint actions', () => {
  const component = new ActionRequired(
    request({
      message: 'Verify the implementation.',
      verificationReportLink: 'Verification report',
      manualReviewSteps: [
        'Open the settings screen and confirm the new control is visible.',
        'Toggle the control and verify the updated behavior.',
      ],
    }),
    identityTheme,
    () => undefined
  )

  const output = component.render(100).join('\n')
  assert.match(
    output,
    /Manual Review Steps[\s\S]*1\. Open the settings screen[\s\S]*2\. Toggle the control[\s\S]*Verification report[\s\S]*▸\[ Continue \]/
  )
})

test('wraps manual review steps without clipping', () => {
  const lines = new ActionRequired(
    request({
      manualReviewSteps: [
        'This manual review step is deliberately long enough to wrap across multiple lines.',
      ],
    }),
    identityTheme,
    () => undefined
  ).render(30)

  assert.match(lines.join('\n'), /Manual Review Steps/)
  assert.ok(lines.every((line) => visibleWidth(line) <= 30))
})

test('renders the checkpoint with an accented border and elevated background', () => {
  const foregrounds: string[] = []
  const backgrounds: string[] = []
  const theme = {
    fg: (color: string, text: string) => {
      foregrounds.push(color)
      return text
    },
    bg: (color: string, text: string) => {
      backgrounds.push(color)
      return text
    },
    bold: (text: string) => text,
    inverse: (text: string) => text,
  } as unknown as Theme

  const lines = new ActionRequired(request(), theme, () => undefined).render(80)

  assert.match(lines[0] ?? '', /CHECKPOINT/)
  assert.ok(foregrounds.includes('borderAccent'))
  assert.equal(backgrounds.length, lines.length)
  assert.ok(backgrounds.every((color) => color === 'customMessageBg'))
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
  const component = new ActionRequired(request(), identityTheme, (action) => {
    selected.push(action)
  }
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
    () => { executions++ }
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

const manualReview: ManualReview = {
  taskId: 'T1', identity: 'attempt', reportId: 'report', createdAt: 1,
  items: [
    { id: 'T1:MR1', text: 'Inspect rendering', status: 'not_checked', observation: '', updatedAt: 1 },
    { id: 'T1:MR2', text: 'Compare paddle movement', status: 'passed', observation: 'Arrows work', updatedAt: 2 },
  ],
}
const nextInput = () => new Promise<void>(resolve => setImmediate(resolve))

test('checklist cycles in order, navigates items, and only renders persisted changes', async () => {
  const selected: DashboardAction[] = []
  const saved = structuredClone(manualReview)
  const component = new ActionRequired(request({ manualReview: saved }), identityTheme, async action => { selected.push(action) })
  assert.match(component.render(110).join('\n'), /1 passed · 0 failed · 1 not checked/)
  component.handleInput(' ')
  await nextInput()
  assert.equal(selected.at(-1)?.status, 'passed')
  assert.match(component.render(110).join('\n'), /▸\[ \] 1\. Inspect rendering/)
  saved.items[0].status = 'passed'
  component.setState(request({ manualReview: structuredClone(saved) }))
  component.handleInput(' ')
  await nextInput()
  assert.equal(selected.at(-1)?.status, 'failed')
  saved.items[0].status = 'failed'
  saved.items[0].observation = 'Missing field'
  component.setState(request({ manualReview: structuredClone(saved) }))
  component.handleInput(' ')
  await nextInput()
  assert.equal(selected.at(-1)?.status, 'not_checked')
  component.handleInput('\x1b[B')
  component.handleInput('\r')
  await nextInput()
  assert.equal(selected.at(-1)?.itemId, 'T1:MR2')
  assert.equal(selected.at(-1)?.status, undefined)
  assert.ok(component.render(30).every(line => visibleWidth(line) <= 30))
})

test('checklist Tab enters actions, disabled actions cannot execute, and modal input passes through', async () => {
  let finish!: () => void
  let calls = 0
  const component = new ActionRequired(request({ manualReview, actions: [{ id: 'approve', label: 'Approve task', disabled: true }, { id: 'repair', label: 'Request fixes', manualReview }] }), identityTheme, async () => { calls++; await new Promise<void>(resolve => { finish = resolve }) })
  component.handleInput('\t')
  component.handleInput('\r')
  assert.equal(calls, 0)
  component.handleInput('\t')
  component.handleInput('\r')
  await nextInput()
  assert.equal(calls, 1)
  assert.equal(component.handleInput('\r'), false)
  assert.equal(component.handleInput('\t'), false)
  assert.equal(component.handleInput(' '), false)
  finish()
  await nextInput()
  component.handleInput('\t')
  component.handleInput(' ')
  await nextInput()
  assert.equal(calls, 2)
  finish()
  await nextInput()
})

test('failure editor requires feedback, cancellation preserves the saved item, and Enter edits observations', async () => {
  const before = structuredClone(manualReview)
  const cancelled = await editManualReviewItem(manualReview, 'T1:MR2', 'failed', async (_title, value) => {
    assert.equal(value, 'Arrows work'); return undefined
  })
  assert.equal(cancelled, undefined)
  assert.deepEqual(manualReview, before)
  await assert.rejects(editManualReviewItem(manualReview, 'T1:MR2', 'failed', async () => ' '), /nonblank observation/)
  const failed = await editManualReviewItem(manualReview, 'T1:MR2', 'failed', async () => 'A/D do not work')
  assert.equal(failed?.status, 'failed')
  assert.equal(failed?.observation, 'A/D do not work')
  const edited = await editManualReviewItem(manualReview, 'T1:MR2', undefined, async () => 'Confirmed twice')
  assert.equal(edited?.status, 'passed')
  assert.equal(edited?.observation, 'Confirmed twice')
  assert.deepEqual(manualReview, before)
})

test('failure checklist replaces manual steps and cycles Pass, Fail, Ignored inline', async () => {
  const selected: DashboardAction[] = []
  const items = [
    { id: 'T1:AC2:O1', text: 'Holding Left moves the paddle left.', status: 'not_checked' as const, observation: '' },
  ]
  const state = request({ manualReview, failureReviewItems: items, actions: [{ id: 'submit', label: 'Continue', manualReview }] })
  const component = new ActionRequired(state, identityTheme, async action => { selected.push(action) })
  const output = component.render(100).join('\n')
  assert.match(output, /Failure Review Steps/)
  assert.match(output, /Holding Left moves/)
  assert.doesNotMatch(output, /Manual Review Steps|Inspect rendering|AC2:O1|Observed:|Decision:|Review failures/)
  for (const status of ['passed', 'failed', 'ignored', 'passed'] as const) {
    component.handleInput(' ')
    await nextInput()
    assert.equal(selected.at(-1)?.id, 'failure-review-update')
    assert.equal(selected.at(-1)?.failureStatus, status)
    component.setState({ ...state, failureReviewItems: [{ ...items[0], status }] })
  }
  component.handleInput('\r')
  await nextInput()
  assert.equal(selected.at(-1)?.failureStatus, undefined)
  assert.equal(selected.at(-1)?.itemId, 'T1:AC2:O1')
  assert.ok(component.render(32).every(line => visibleWidth(line) <= 32))
  component.handleInput('\t')
  component.handleInput('\r')
  await nextInput()
  assert.equal(selected.at(-1)?.id, 'submit')
})
