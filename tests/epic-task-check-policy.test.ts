import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import {
  resolveAvailableCheckNames,
  stableCheckNamesForVerification,
} from '../pi/extensions/epic/checks.ts'
import { validateTaskCheckPolicies } from '../pi/extensions/epic/task-check-policy.ts'
import type {
  EpicTask,
  ResolvedEpicConfiguration,
} from '../pi/extensions/epic/types.ts'

function task(
  id: string,
  verification: string[],
  requiredChecks: string[] = [],
  deferredChecks: string[] = []
): EpicTask {
  return {
    id,
    title: id,
    objective: id,
    files: { context: [], expectedChanges: [] },
    implementation: [],
    acceptanceCriteria: ['Complete'],
    verification,
    manualReviewSteps: ['Review in the browser'],
    risks: [],
    requiredChecks,
    deferredChecks,
    reason: 'Dependency order.',
  }
}

function configuration(
  checks: ResolvedEpicConfiguration['checks'] = {}
): ResolvedEpicConfiguration {
  return {
    inspector: { enabled: false, port: 8080, autoOpen: false },
    agentTimeoutMs: 10_000,
    commandTimeoutMs: 10_000,
    maxOutputBytes: 20_000,
    maxScoutRounds: 3,
    maxFastRepairs: 2,
    maxFullRepairs: 1,
    maxSemanticRepairs: 2,
    maxTaskPlanRepairs: 2,
    checks,
    agents: {},
  }
}

test('manual browser verification never provides focused-tests', () => {
  assert.deepEqual(
    stableCheckNamesForVerification('Browser smoke test covering gameplay'),
    []
  )
  const result = validateTaskCheckPolicies(
    [task('task-1', ['npm run build'], ['build', 'focused-tests'])],
    ['diff-check']
  )
  assert.equal(result.valid, false)
  assert.match(result.errors[0] ?? '', /Task task-1 requires focused-tests/)
})

test('setup commands provide stable checks to the task that introduces them', () => {
  const result = validateTaskCheckPolicies(
    [
      task(
        'task-1',
        ['npm install', 'npm run build', 'git diff --check'],
        ['install', 'build', 'diff-check']
      ),
    ],
    []
  )
  assert.deepEqual(result, { valid: true, errors: [] })
})

test('deferred checks may be introduced later but required checks may not', () => {
  const valid = validateTaskCheckPolicies(
    [
      task('task-1', ['git diff --check'], ['diff-check'], ['focused-tests']),
      task('task-2', ['npm test'], ['focused-tests']),
    ],
    []
  )
  assert.equal(valid.valid, true)

  const invalid = validateTaskCheckPolicies(
    [
      task('task-1', ['git diff --check'], ['focused-tests']),
      task('task-2', ['npm test'], ['focused-tests']),
    ],
    []
  )
  assert.equal(invalid.valid, false)
  assert.match(invalid.errors[0] ?? '', /no executable command provides it by this task/)
})

test('configured focused-tests is available without a package test script', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'epic-check-policy-'))
  try {
    const available = await resolveAvailableCheckNames(
      root,
      configuration({ focusedTests: 'npx playwright test' })
    )
    assert.ok(available.includes('focused-tests'))
    assert.equal(
      validateTaskCheckPolicies(
        [task('task-1', [], ['focused-tests'])],
        available
      ).valid,
      true
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('final-only configured checks may be deferred but not required by a task', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'epic-check-policy-'))
  try {
    const config = configuration({ final: ['custom-final-check'] })
    const taskAvailable = await resolveAvailableCheckNames(root, config)
    const finalAvailable = await resolveAvailableCheckNames(root, config, [
      'fast',
      'full',
      'final',
    ])
    assert.equal(
      validateTaskCheckPolicies(
        [task('task-1', [], [], ['final-1'])],
        taskAvailable,
        finalAvailable
      ).valid,
      true
    )
    assert.equal(
      validateTaskCheckPolicies(
        [task('task-1', [], ['final-1'])],
        taskAvailable,
        finalAvailable
      ).valid,
      false
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
