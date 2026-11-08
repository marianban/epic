import assert from 'node:assert/strict'
import test from 'node:test'
import { reviewerTask } from '../pi/extensions/epic/prompts.ts'
import { validateReviewResult } from '../pi/extensions/epic/review-validation.ts'
import type { EpicDomainState, EpicTask } from '../pi/extensions/epic/types.ts'

const task: EpicTask = {
  id: 'task-1',
  title: 'Render application',
  objective: 'Render the application.',
  files: {
    context: ['src/main.ts'],
    expectedChanges: ['src/main.ts', 'src/new-view.ts'],
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
    reconciliation: [],
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
    ...overrides,
  }
}

function finding(overrides: Record<string, unknown> = {}) {
  return {
    id: 'new:1',
    severity: 'major',
    category: 'correctness',
    file: 'src/main.ts',
    lineStart: 1,
    lineEnd: 1,
    symbol: 'render',
    message: 'Rendering fails.',
    failureScenario: 'The application starts with an empty view.',
    requiredFix: 'Repair the render path.',
    affectedPaths: ['src/main.ts'],
    repairPaths: ['src/main.ts'],
    ...overrides,
  }
}

test('manual-only criteria can remain pending without failing semantic review', () => {
  const result = validateReviewResult(review())
  assert.equal(result.passed, true)
  assert.equal(result.acceptanceCriteria[0]?.status, 'manual_review_pending')
})

test('failed semantic review requires an actionable repair', () => {
  assert.throws(
    () => validateReviewResult(review({ passed: false })),
    /without an actionable repair/
  )
})

test('every semantic finding requires a repair path', () => {
  assert.throws(
    () =>
      validateReviewResult(
        review({ passed: false, findings: [finding({ repairPaths: [] })] })
      ),
    /invalid or unsafe repair feedback/
  )
})

test('planned, unplanned, existing, and new paths are valid repairs', () => {
  for (const repairPath of [
    'src/main.ts',
    'package-lock.json',
    'src/shared/render.ts',
    'tests/new-render.test.ts',
  ]) {
    const result = validateReviewResult(
      review({
        passed: false,
        findings: [
          finding({
            file: repairPath,
            affectedPaths: [repairPath],
            repairPaths: [repairPath],
          }),
        ],
      })
    )
    assert.deepEqual(result.findings[0]?.repairPaths, [repairPath])
  }
})

test('protected and escaping repair paths are rejected', () => {
  for (const repairPath of [
    '../outside.ts',
    '/tmp/outside.ts',
    'C:/outside.ts',
    'bad\0path.ts',
    '.git/config',
    '.pi/epics/state.json',
    '.env',
    'config/.env.local',
    'certs/server.pem',
    'certs/server.key',
  ]) {
    assert.throws(
      () =>
        validateReviewResult(
          review({
            passed: false,
            findings: [finding({ repairPaths: [repairPath] })],
          })
        ),
      /invalid or unsafe repair feedback/,
      repairPath
    )
  }
})

test('reviewer prompt reserves manual checks and treats task files as guidance', () => {
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
    maxRepairsPerItem: 1,
    maxAcceptancePlanRepairs: 2,
    maxTaskInfrastructureRetries: 1,
    taskVerificationTimeoutMs: 1,
    tasks: [task],
  } satisfies EpicDomainState

  const prompt = reviewerTask(
    state,
    'plan',
    'diff',
    'checks',
    'artifact',
    ['package-lock.json']
  )
  assert.match(prompt, /manual_review_pending/)
  assert.match(prompt, /do not create a finding for the missing observation/)
  assert.match(prompt, /files\.context and files\.expectedChanges/)
  assert.match(prompt, /package-lock\.json/)
  assert.match(prompt, /any relevant existing or new file/)
  assert.doesNotMatch(prompt, /proposedRepairPaths/)
})
