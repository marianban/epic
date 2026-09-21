import assert from 'node:assert/strict'
import test from 'node:test'
import { reviewerTask } from '../pi/extensions/epic/prompts.ts'
import { validateReviewResult } from '../pi/extensions/epic/review-validation.ts'
import type { EpicDomainState, EpicTask } from '../pi/extensions/epic/types.ts'

const task: EpicTask = {
  id: 'task-1',
  title: 'Render application',
  objective: 'Render the application.',
  scope: {
    read: [],
    modify: ['src/main.ts'],
    create: [],
    delete: [],
  },
  implementation: [],
  acceptanceCriteria: ['The browser console has no startup errors.'],
  verification: [],
  manualReviewSteps: ['Inspect the browser console.'],
  risks: [],
  requiredChecks: [],
  deferredChecks: [],
  reason: 'Required for the application.',
}

function review(overrides: Record<string, unknown> = {}) {
  return {
    passed: true,
    summary: 'Automated semantic review passed.',
    acceptanceCriteria: [
      {
        criterion: task.acceptanceCriteria[0],
        status: 'manual_review_pending',
        evidence: 'This criterion requires the human browser checkpoint.',
      },
    ],
    findings: [],
    requiresPlanRevision: false,
    ...overrides,
  }
}

test('manual-only criteria can remain pending without failing semantic review', () => {
  const result = validateReviewResult(review(), task)
  assert.equal(result.passed, true)
  assert.equal(result.acceptanceCriteria[0]?.status, 'manual_review_pending')
})

test('failed semantic review requires an actionable repair or plan revision', () => {
  assert.throws(
    () => validateReviewResult(review({ passed: false }), task),
    /without an actionable repair or plan revision/
  )
})

test('every semantic finding requires a non-empty in-scope repair path', () => {
  assert.throws(
    () =>
      validateReviewResult(
        review({
          passed: false,
          findings: [{ repairPaths: [] }],
        }),
        task
      ),
    /invalid or out-of-scope repair feedback/
  )
})

test('reviewer prompt reserves manual checks for the human checkpoint', () => {
  const state = {
    epicId: 'run',
    epic: 'Render application',
    repositoryRoot: '/repo',
    epicComplexity: 'simple',
    scoutRound: 0,
    maxScoutRounds: 3,
    planPath: '/repo/plan.md',
    planRevision: 1,
    planApproved: true,
    currentTaskIndex: 0,
    taskApproved: true,
    implementationAttempt: 1,
    maxFastRepairs: 1,
    maxFullRepairs: 1,
    maxSemanticRepairs: 1,
    tasks: [task],
  } satisfies EpicDomainState

  const prompt = reviewerTask(state, 'plan', 'diff', 'checks', 'artifact')
  assert.match(prompt, /manual_review_pending/)
  assert.match(prompt, /do not create a finding for the missing observation/)
})
