import { manualReviewSubmission } from '../pi/extensions/epic/dashboard/manual-review-submission.ts'
import { projectDashboardState } from '../pi/extensions/epic/dashboard/projection.ts'
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import type { EpicDomainState, EpicClock } from '../pi/extensions/epic/types.ts'
import type {
  VerificationPlan,
  VerificationOperation,
  AcceptanceEvidence,
} from '../pi/extensions/epic/verification-types.ts'
import {
  VerificationStore,
  taskVerificationPath,
} from '../pi/extensions/epic/verification-store.ts'
import {
  runTaskVerification,
  type VerificationDependencies,
} from '../pi/extensions/epic/verification-runner.ts'
import { validateVerificationPlan } from '../pi/extensions/epic/verification-plan.ts'
import { validateAcceptanceEvidence } from '../pi/extensions/epic/acceptance-validation.ts'
import {
  decideTask,
  assertAcceptedReport,
} from '../pi/extensions/epic/verification-decisions.ts'
import { BrowserExecution } from '../pi/extensions/epic/browser-execution.ts'
import { openBrowserBridge } from '../pi/extensions/epic/browser-bridge.ts'
import type { BrowserProbe, BrowserProbeResponse } from '../pi/extensions/epic/browser-evidence-types.ts'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { resolveEpicConfiguration } from '../pi/extensions/epic/configuration.ts'
import verifierTools from '../pi/extensions/epic/verifier-tools.ts'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { runCheckSuite } from '../pi/extensions/epic/checks.ts'
import { createActor } from 'xstate'
import { createEpicMachine } from '../pi/extensions/epic/machines/epic-machine.ts'
import { createEpicRuntime } from '../pi/extensions/epic/runtime.ts'
import type { EpicServices } from '../pi/extensions/epic/services.ts'
import { loadActiveEpic, persistEpicTasks } from '../pi/extensions/epic/persistence.ts'
import { constructReviewReport, reviewReportMarkdown } from '../pi/extensions/epic/verification-report.ts'
import { latestTaskRepairRequest } from '../pi/extensions/epic/task-repair-request.ts'

const exec = promisify(execFile)
const realClock: EpicClock = {
  now: () => new Date().toISOString(),
  nowMs: () => Date.now(),
}
const timer = { setTimeout, clearTimeout }
async function fixture(t: TestContext, repairs = 3, clock = realClock) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await exec('git', ['init', '-q'], { cwd: root })
  await fs.writeFile(path.join(root, '.gitignore'), '.pi/\n')
  await fs.writeFile(path.join(root, 'candidate.txt'), 'good')
  const state: EpicDomainState = {
    epicId: 'run',
    epic: 'fixture',
    repositoryRoot: root,
    epicComplexity: 'simple',
    scoutRound: 0,
    maxScoutRounds: 3,
    planPath: path.join(root, 'plan.md'),
    planRevision: 1,
    planApproved: true,
    currentTaskIndex: 0,
    taskApproved: true,
    implementationAttempt: 1,
    maxTaskRepairs: repairs,
    maxAcceptancePlanRepairs: 2,
    maxTaskInfrastructureRetries: 1,
    taskVerificationTimeoutMs: 30_000,
    tasks: [
      {
        id: 'T1',
        title: 'Fixture',
        objective: 'Verify fixture',
        files: { context: [], expectedChanges: [] },
        implementation: [],
        acceptanceCriteria: ['Candidate is good'],
        verification: [],
        manualReviewSteps: [],
        risks: [],
        requiredChecks: [],
        deferredChecks: [],
        reason: 'test',
      },
    ],
  }
  const store = new VerificationStore(taskVerificationPath(state), clock)
  const record = await store.initialize(state)
  const plan: VerificationPlan = {
    version: 1,
    criterionVersion: 1,
    criteria: record.criteria,
    obligations: [
      {
        id: 'good',
        criterionId: 'T1:AC1',
        expected: 'Candidate is good',
        method: 'automated',
        command: `node -e "if(require('fs').readFileSync('candidate.txt','utf8') !== 'good') throw Error('Candidate defect')"`,
      },
    ],
  }
  record.plan = plan
  await store.write(record)
  const calls: string[] = []
  const dependencies: VerificationDependencies = {
    clock,
    timer,
    executablePath: undefined,
    maxOutputBytes: 5000,
    browserProbeLimits: { maxFrames: 12, maxCaptureDurationMs: 10_000 },
    checks: async (current, suite, operation) => {
      assert.ok(operation.remainingMs() > 0)
      calls.push(suite)
      return {
        state: current,
        result: {
          suite,
          passed: true,
          checks: [],
          introducedFindings: [],
          preExistingFindings: [],
          deferredChecks: [],
        },
      }
    },
    review: async (current) => {
      calls.push('review')
      return {
        state: current,
        result: {
          passed: true,
          summary: 'No defects',
          acceptanceCriteria: [],
          findings: [],
        },
      }
    },
    repair: async (current) => {
      const saved = await store.read()
      assert.equal(saved.invocations.at(-1)?.kind, 'repair')
      calls.push('repair')
      await fs.writeFile(path.join(root, 'candidate.txt'), 'good')
      return current
    },
    explore: async () => {
      throw new Error('Unexpected exploration')
    },
  }
  return { root, state, store, record, plan, calls, dependencies }
}

test('task review Markdown stays separate from execution artifacts', async (t) => {
  const f = await fixture(t)
  assert.ok(f.state.tasks)
  const manifest = await persistEpicTasks(f.state, f.state.tasks)
  const run = path.join(f.root, '.pi', 'epics', 'runs', f.state.epicId)
  const taskFile = path.join(run, 'tasks', 'task-001.md')
  await fs.appendFile(taskFile, 'R: Keep this human review instruction.\n')
  const markdown = await fs.readFile(taskFile, 'utf8')
  const state = await runTaskVerification(
    f.state,
    new AbortController().signal,
    f.dependencies
  )
  assert.equal((await f.store.read()).report?.readiness, 'verified')
  assert.equal(manifest, path.join(run, 'artifacts', 'tasks.json'))
  assert.equal(f.store.file, path.join(run, 'artifacts', 'task-1-verification.json'))
  assert.deepEqual(await fs.readdir(path.join(run, 'tasks')), ['task-001.md'])
  assert.equal(await fs.readFile(taskFile, 'utf8'), markdown)
  const artifacts = await fs.readdir(path.join(run, 'artifacts'))
  assert.ok(artifacts.some(file => file.endsWith('-command.json')))
  assert.ok(state.lastVerificationReportPath)
})

test('successful acceptance remains report-bound across candidate changes', async (t) => {
  const f = await fixture(t)
  const state = await runTaskVerification(
    f.state,
    new AbortController().signal,
    f.dependencies
  )
  const record = await f.store.read()
  assert.equal(record.report?.readiness, 'verified')
  assert.equal(record.decisions.length, 0)
  assert.deepEqual(f.calls, ['fast', 'full', 'review'])
  assert.ok(state.lastVerificationReportPath)
  await assert.rejects(
    assertAcceptedReport(state, realClock),
    /Checkpoint requires/
  )
  const accepted = await decideTask(state, { kind: 'approve' }, realClock)
  await assertAcceptedReport(accepted, realClock)
  await fs.writeFile(path.join(f.root, 'candidate.txt'), 'changed')
  await assertAcceptedReport(accepted, realClock)
  await decideTask(state, { kind: 'approve' }, realClock)
  // Even identical source must not let a previous report accept a new attempt.
  await fs.writeFile(path.join(f.root, 'candidate.txt'), 'good')
  await runTaskVerification(state, new AbortController().signal, f.dependencies)
  const nextReport = (await f.store.read()).report
  assert.equal(nextReport?.readiness, 'verified')
  assert.notEqual(nextReport?.identity, record.report?.identity)
  assert.ok(record.report)
  await assert.rejects(
    decideTask(
      state,
      {
        kind: 'grant',
        identity: record.report.identity,
        reportId: record.report.id,
        repairs: 1,
        timeMs: 1000,
        reason: 'Old report',
      },
      realClock
    ),
    /current attempt\/report/
  )
  await assert.rejects(
    assertAcceptedReport(accepted, realClock),
    /Checkpoint requires/
  )
})

test('repair is charged before invocation and reruns every required phase', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.root, 'candidate.txt'), 'bad')
  await runTaskVerification(
    f.state,
    new AbortController().signal,
    f.dependencies
  )
  const record = await f.store.read()
  assert.deepEqual(f.calls, [
    'fast',
    'full',
    'review',
    'repair',
    'fast',
    'full',
    'review',
  ])
  assert.equal(record.invocations.length, 1)
  assert.equal(record.report?.readiness, 'verified')
  assert.equal(record.cycles[0]?.evidence[0]?.outcome, 'fail')
  assert.notEqual(record.cycles[0]?.identity, record.cycles[1]?.identity)
})

for (const failedSuite of ['fast', 'full'] as const) {
  for (const repairs of [0, 1]) {
    test(`${failedSuite} failure gates later stages with ${repairs} repair allowance`, async (t) => {
      const f = await fixture(t, repairs)
      const name = failedSuite === 'fast' ? 'lint' : 'build'
      const task = f.state.tasks?.[0]
      assert.ok(task)
      task.requiredChecks = [name]
      const checks = f.dependencies.checks
      let failed = false
      f.dependencies.checks = async (...args) => {
        const checked = await checks(...args)
        if (args[1] === failedSuite) {
          const passed = failed
          failed = true
          checked.result.passed = passed
          checked.result.checks.push({
            name,
            command: `npm run ${name}`,
            required: true,
            passed,
            exitCode: passed ? 0 : 1,
            durationMs: 1,
            stdoutPreview: '',
            stderrPreview: passed ? '' : 'Stage defect',
            findings: [],
            outputTruncated: false,
          })
        }
        return checked
      }
      const repair = f.dependencies.repair
      f.dependencies.repair = async (state, feedback, operation) => {
        assert.match(feedback, /Stage defect/)
        const record = await f.store.read()
        const cycle = record.cycles.at(-1)
        assert.ok(cycle)
        assert.equal(cycle.review, undefined)
        assert.equal(cycle.smoke, undefined)
        assert.deepEqual(cycle.evidence, [])
        if (failedSuite === 'fast') assert.equal(cycle.full, undefined)
        return repair(state, feedback, operation)
      }
      const state = await runTaskVerification(f.state, new AbortController().signal, f.dependencies)
      const record = await f.store.read()
      const firstStages = failedSuite === 'fast' ? ['fast'] : ['fast', 'full']
      assert.deepEqual(f.calls, repairs
        ? [...firstStages, 'repair', 'fast', 'full', 'review']
        : firstStages)
      assert.equal(record.invocations.filter(i => i.kind === 'repair').length, repairs)
      assert.equal(record.report?.readiness, repairs ? 'verified' : 'issues_remaining')
      if (!repairs) {
        assert.ok(record.report?.unresolved.includes(`check:${name}`))
        await assert.rejects(decideTask(state, { kind: 'approve' }, realClock), /Ordinary approval/)
      }
    })
  }
}

test('latest-report repair grant resumes an exhausted task and repairs its observed defect', async (t) => {
  const f = await fixture(t, 0)
  await fs.writeFile(path.join(f.root, 'candidate.txt'), 'bad')
  const state = await runTaskVerification(f.state, new AbortController().signal, f.dependencies)
  const before = await f.store.read()
  assert.equal(before.report?.readiness, 'issues_remaining')
  const granted = await decideTask(state, latestTaskRepairRequest(
    before.report, { repairs: 1, timeMs: 300_000 }, false
  ), realClock)
  await runTaskVerification(granted, new AbortController().signal, f.dependencies)
  const after = await f.store.read()
  assert.equal(after.repairsLimit, 1)
  assert.equal(after.invocations.filter(i => i.kind === 'repair').length, 1)
  assert.equal(after.grants.length, 1)
  assert.equal(after.timeAllowanceMs, before.timeAllowanceMs + 300_000)
  assert.equal(after.report?.readiness, 'verified')
  assert.notEqual(after.report?.id, before.report?.id)
})

for (const repairs of [0, 3])
  test(`${repairs} repair allowance exhausts at the human report and survives replacement/resume`, async (t) => {
    const f = await fixture(t, repairs)
    await fs.writeFile(path.join(f.root, 'candidate.txt'), 'bad')
    f.dependencies.repair = async (state) => {
      assert.equal((await f.store.read()).invocations.at(-1)?.kind, 'repair')
      f.calls.push('repair')
      return state
    }
    const state = await runTaskVerification(
      f.state,
      new AbortController().signal,
      f.dependencies
    )
    const record = await f.store.read()
    assert.equal(
      record.invocations.filter((i) => i.kind === 'repair').length,
      repairs
    )
    assert.equal(record.report?.readiness, 'issues_remaining')
    assert.equal(record.report?.criteria.length, 1)
    await runTaskVerification(
      state,
      new AbortController().signal,
      f.dependencies
    )
    assert.equal(
      (
        await new VerificationStore(f.store.file, realClock).read()
      ).invocations.filter((i) => i.kind === 'repair').length,
      repairs
    )
  })

test('one shared infrastructure retry does not edit the application', async (t) => {
  const f = await fixture(t)
  let invocations = 0
  f.dependencies.checks = async () => {
    invocations++
    throw new Error('Tool unavailable')
  }
  const state = await runTaskVerification(
    f.state,
    new AbortController().signal,
    f.dependencies
  )
  const record = await f.store.read()
  assert.equal(invocations, 2)
  assert.deepEqual(f.calls, [])
  assert.equal(
    record.invocations.filter((i) => i.kind === 'infrastructure').length,
    1
  )
  assert.equal(record.invocations.filter((i) => i.kind === 'repair').length, 0)
  assert.equal(record.report?.readiness, 'needs_manual_confirmation')
  await assert.rejects(
    decideTask(state, { kind: 'approve' }, realClock),
    /Ordinary approval/
  )
  assert.equal(
    await fs.readFile(path.join(f.root, 'candidate.txt'), 'utf8'),
    'good'
  )
})

test('deadline aborts operations and finalizes without more agent work', async (t) => {
  let now = 0
  const clock = { now: () => new Date(now).toISOString(), nowMs: () => now }
  const f = await fixture(t, 3, clock)
  f.dependencies.checks = async (_state, _suite, operation) => {
    now = 30_001
    operation.remainingMs()
    throw new Error('unreachable')
  }
  await runTaskVerification(
    f.state,
    new AbortController().signal,
    f.dependencies
  )
  const record = await f.store.read()
  assert.equal(record.report?.usage.remainingMs, 0)
  assert.equal(record.invocations.length, 0)
  assert.deepEqual(f.calls, [])
  assert.equal(record.report?.criteria[0]?.status, 'manual_review_pending')
})

test('ledger pauses exclude human waiting, active downtime counts, and grants preserve usage', async (t) => {
  let now = 100
  const clock = { now: () => new Date(now).toISOString(), nowMs: () => now }
  const f = await fixture(t, 3, clock)
  const r = await f.store.read()
  await f.store.start(r)
  await f.store.charge(r, 'repair', 'Concrete defect')
  now = 1100
  assert.equal(f.store.remaining(r), 29_000)
  await f.store.pause(r)
  now = 100_000
  assert.equal(f.store.remaining(r), 29_000)
  await f.store.start(r)
  now += 2000
  assert.equal(f.store.remaining(r), 27_000)
  const replacement = new VerificationStore(f.store.file, clock)
  now += 1000
  assert.equal(replacement.remaining(await replacement.read()), 26_000)
  await replacement.grant(r, {
    repairs: 2,
    timeMs: 1000,
    reason: 'User grant',
    at: now,
  })
  assert.equal(r.repairsLimit, 5)
  assert.equal(r.invocations.length, 1)
})

test('evidence validation preserves independent results and rejects missing, contradictory, duplicate, and stale claims', async (t) => {
  const f = await fixture(t)
  await runTaskVerification(
    f.state,
    new AbortController().signal,
    f.dependencies
  )
  const cycle = (await f.store.read()).cycles[0]
  assert.ok(cycle)
  const good = cycle.evidence[0]
  assert.ok(good)
  const firstObligation = f.plan.obligations[0]
  assert.ok(firstObligation)
  const more = {
    ...f.plan,
    obligations: [...f.plan.obligations, { ...firstObligation, id: 'second' }],
  }
  const checked = await validateAcceptanceEvidence(
    [good, { ...good, obligationId: 'second', identity: 'stale' }],
    more,
    cycle.identity,
    cycle.attempt,
    path.dirname(f.store.file)
  )
  assert.equal(checked.evidence.length, 1)
  assert.ok(checked.problems.some((p) => p.includes('second')))
  const missing = await validateAcceptanceEvidence(
    [{ ...good, artifacts: ['/missing'] }],
    f.plan,
    cycle.identity,
    cycle.attempt,
    path.dirname(f.store.file)
  )
  assert.equal(missing.evidence.length, 0)
  const contradictory = await validateAcceptanceEvidence(
    [{ ...good, outcome: 'fail' }],
    f.plan,
    cycle.identity,
    cycle.attempt,
    path.dirname(f.store.file)
  )
  assert.equal(contradictory.evidence.length, 0)
  const duplicated = await validateAcceptanceEvidence(
    [good, good],
    f.plan,
    cycle.identity,
    cycle.attempt,
    path.dirname(f.store.file)
  )
  assert.equal(duplicated.evidence.length, 0)
})

test('incomplete evidence offers manual review and rejects removed limitations decisions', async (t) => {
  const f = await fixture(t)
  f.record.plan = {
    ...f.plan,
    obligations: [
      {
        id: 'visual',
        criterionId: 'T1:AC1',
        expected: 'Looks right',
        method: 'human_only',
        reason: 'Subjective judgment',
      },
    ],
  }
  await f.store.write(f.record)
  const state = await runTaskVerification(
    f.state,
    new AbortController().signal,
    f.dependencies
  )
  const report = (await f.store.read()).report
  assert.ok(report)
  assert.equal(report.readiness, 'needs_manual_confirmation')
  const markdown = reviewReportMarkdown(report)
  assert.doesNotMatch(markdown, /\/task-repair/)
  assert.match(markdown, /Review it manually/)
  const beforeRejectedRepair = await f.store.read()
  await assert.rejects(decideTask(state, {
    kind: 'grant', identity: report.identity, reportId: report.id,
    repairs: 1, timeMs: 300_000, reason: 'Try repairing missing evidence',
  }, realClock), /No actionable failure/)
  assert.deepEqual(await f.store.read(), beforeRejectedRepair)
  assert.doesNotMatch(markdown, /task-accept|Accept this report/)
  await assert.rejects(decideTask(state, JSON.parse(JSON.stringify({
    kind: 'accept_unresolved', identity: report.identity, reportId: report.id,
    obligations: report.unresolved, reason: 'Bypass manual review',
  })), realClock), /Unsupported task decision: accept_unresolved/)
  await assert.rejects(decideTask(state, { kind: 'approve' }, realClock), /Complete all manual steps/)
  assert.deepEqual(await f.store.read(), beforeRejectedRepair)
})

test('plans cannot omit criteria, redefine them, or remove browser assertions', () => {
  const criteria = [{ id: 'AC1', text: 'Counter increments' }]
  assert.throws(
    () =>
      validateVerificationPlan(
        { version: 1, criterionVersion: 1, criteria, obligations: [] },
        criteria,
        1
      ),
    /omitted/
  )
  assert.throws(
    () =>
      validateVerificationPlan(
        {
          version: 1,
          criterionVersion: 1,
          criteria: [{ id: 'AC1', text: 'Startup works' }],
          obligations: [],
        },
        criteria,
        1
      ),
    /changed frozen/
  )
  assert.throws(
    () =>
      validateVerificationPlan(
        {
          version: 1,
          criterionVersion: 1,
          criteria,
          obligations: [
            {
              id: 'click',
              criterionId: 'AC1',
              expected: 'Counter increments',
              method: 'automated',
              steps: [{ action: 'click', selector: 'button', value: '' }],
            },
          ],
        },
        criteria,
        1
      ),
    /assertion/
  )
})

test('agent browser plans freeze expectations without requiring executable assertions', () => {
  const criteria = [{ id: 'AC1', text: 'Counter increments' }]
  for (const steps of [undefined, [{ action: 'click', selector: 'button', value: '' }]]) {
    const plan = {
      version: 1,
      criterionVersion: 1,
      criteria,
      obligations: [{
        id: 'counter',
        criterionId: 'AC1',
        expected: 'Counter increments once after clicking',
        method: 'agent_browser',
        ...(steps ? { steps } : {}),
      }],
    }
    assert.deepEqual(validateVerificationPlan(plan, criteria, 1), plan)
  }
})

test('configuration allows zero repairs/retries and rejects obsolete settings', async (t) => {
  const f = await fixture(t)
  const file = path.join(f.root, '.pi/epic.config.json')
  await fs.writeFile(
    file,
    JSON.stringify({ maxTaskRepairs: 0, maxTaskInfrastructureRetries: 0 })
  )
  const config = await resolveEpicConfiguration(f.root)
  assert.equal(config.maxTaskRepairs, 0)
  assert.equal(config.maxTaskInfrastructureRetries, 0)
  await fs.writeFile(file, JSON.stringify({ maxFastRepairs: 2 }))
  await assert.rejects(
    resolveEpicConfiguration(f.root),
    /Obsolete.*No compatibility migration/
  )
})

test('combined obligations aggregate partial results without treating human-only absence as a defect', async (t) => {
  const f = await fixture(t)
  f.record.plan = {
    ...f.plan,
    obligations: [
      ...f.plan.obligations,
      {
        id: 'appearance',
        criterionId: 'T1:AC1',
        expected: 'Appearance approved',
        method: 'human_only',
        reason: 'Subjective appearance',
      },
    ],
  }
  await f.store.write(f.record)
  await runTaskVerification(
    f.state,
    new AbortController().signal,
    f.dependencies
  )
  const report = (await f.store.read()).report
  assert.equal(report?.criteria[0]?.status, 'partially_met')
  assert.equal(report?.readiness, 'needs_manual_confirmation')
  assert.equal(report?.usage.repairs, 0)
})

test('failed scheduled smoke blocks verified approval even when acceptance evidence passes', async (t) => {
  const f = await fixture(t)
  await runTaskVerification(
    f.state,
    new AbortController().signal,
    f.dependencies
  )
  const record = await f.store.read()
  const cycle = record.cycles.at(-1)
  assert.ok(cycle)
  cycle.smoke = {
    passed: false,
    url: 'http://127.0.0.1/',
    readySelector: 'main',
    durationMs: 0,
    server: {
      command: 'node',
      args: [],
      url: 'http://127.0.0.1/',
      stdoutPreview: '',
      stderrPreview: '',
      outputTruncated: false,
    },
    findings: [
      {
        source: 'browser-smoke',
        severity: 'error',
        category: 'infrastructure',
        message: 'Screenshot tool unavailable',
      },
    ],
  }
  const report = constructReviewReport(
    record,
    cycle.identity,
    f.store.remaining(record)
  )
  assert.equal(report.criteria[0]?.status, 'met')
  assert.equal(report.readiness, 'needs_manual_confirmation')
  assert.ok(report.unresolved.includes('check:browser-smoke'))
})

test('source and generated dependency changes preserve advisory verification results', async (t) => {
  const f = await fixture(t)
  const review = f.dependencies.review
  f.dependencies.review = async (state, cycle, operation) => {
    await fs.writeFile(path.join(f.root, 'candidate.txt'), 'changed')
    await fs.mkdir(path.join(f.root, 'node_modules/generated-cache'), {
      recursive: true,
    })
    await fs.writeFile(
      path.join(f.root, 'node_modules/generated-cache/metadata.json'),
      '{}'
    )
    return review(state, cycle, operation)
  }
  const state = await runTaskVerification(
    f.state,
    new AbortController().signal,
    f.dependencies
  )
  const report = (await f.store.read()).report
  assert.equal(report?.readiness, 'verified')
  assert.equal(report?.criteria[0]?.status, 'met')
  assert.equal(report?.history[0]?.evidence[0]?.outcome, 'pass')
  assert.equal(report?.history[0]?.invalidated, undefined)
  assert.equal(report?.cycle?.evidence[0]?.outcome, 'pass')
  assert.equal(report?.usage.repairs, 0)
  const accepted = await decideTask(state, { kind: 'approve' }, realClock)
  await assertAcceptedReport(accepted, realClock)
})

test('criterion revisions and explicit grants preserve charged usage and invalidate acceptance', async (t) => {
  const f = await fixture(t, 0)
  await fs.writeFile(path.join(f.root, 'candidate.txt'), 'bad')
  const state = await runTaskVerification(
    f.state,
    new AbortController().signal,
    f.dependencies
  )
  const report = (await f.store.read()).report
  assert.ok(report)
  await decideTask(
    state,
    {
      kind: 'grant',
      identity: report.identity,
      reportId: report.id,
      repairs: 1,
      timeMs: 10_000,
      reason: 'One additional attempt',
    },
    realClock
  )
  await runTaskVerification(state, new AbortController().signal, f.dependencies)
  const record = await f.store.read()
  assert.ok(record.report)
  assert.equal(record.invocations.filter((i) => i.kind === 'repair').length, 1)
  const revised = await decideTask(
    state,
    {
      kind: 'revise_criteria',
      identity: record.report.identity,
      reportId: record.report.id,
      criteria: ['New expected behavior'],
      reason: 'Requirement revised',
    },
    realClock
  )
  const saved = await f.store.read()
  assert.equal(saved.criterionVersion, 2)
  assert.equal(saved.plan, undefined)
  assert.equal(saved.report, undefined)
  assert.equal(saved.invocations.length, 1)
  assert.equal(saved.grants.length, 1)
  assert.equal(
    revised.tasks?.[0]?.acceptanceCriteria[0],
    'New expected behavior'
  )
})

test('interrupted repairs remain charged, preserve artifacts, and ordinary resume does not repeat them', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.root, 'candidate.txt'), 'bad')
  const controller = new AbortController()
  f.dependencies.repair = async (state) => {
    controller.abort(new Error('User cancelled repair'))
    throw new Error(`Interrupted ${state.epicId}`)
  }
  await runTaskVerification(f.state, controller.signal, f.dependencies)
  const interrupted = await f.store.read()
  assert.equal(interrupted.invocations.length, 1)
  assert.equal(interrupted.invocations[0]?.completed, false)
  assert.ok(interrupted.report)
  assert.equal(interrupted.cycles[0]?.evidence[0]?.outcome, 'fail')
  f.dependencies.repair = async () => {
    assert.fail('Resume repeated an interrupted repair.')
  }
  await runTaskVerification(
    f.state,
    new AbortController().signal,
    f.dependencies
  )
  assert.equal(
    (await f.store.read()).invocations.filter((i) => i.kind === 'repair')
      .length,
    1
  )
})

test('persistence failure prevents launching a charged repair', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.root, 'candidate.txt'), 'bad')
  const original = VerificationStore.prototype.write
  t.mock.method(
    VerificationStore.prototype,
    'write',
    async function (
      this: VerificationStore,
      record: Parameters<typeof original>[0]
    ) {
      if (record.invocations.some((i) => i.kind === 'repair'))
        throw new Error('Ledger disk full')
      await original.call(this, record)
    }
  )
  await assert.rejects(
    runTaskVerification(f.state, new AbortController().signal, f.dependencies),
    /Ledger disk full/
  )
  assert.equal(f.calls.includes('repair'), false)
})

test('dependency verification checks installed packages without reinstalling candidate inputs', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(
    path.join(f.root, 'package.json'),
    JSON.stringify({ name: 'acceptance-fixture', version: '1.0.0' })
  )
  assert.ok(f.state.tasks?.[0])
  f.state.tasks[0].requiredChecks = ['install']
  const configuration = await resolveEpicConfiguration(f.root)
  const result = await runCheckSuite(
    'fast',
    f.state,
    realClock.now(),
    configuration,
    { signal: new AbortController().signal, remainingMs: () => 10_000 }
  )
  const install = result.checks.find((c) => c.name === 'install')
  assert.equal(install?.command, 'npm ls --all --json')
  assert.equal(install?.passed, true)
  assert.deepEqual(install?.findings, [])
  assert.deepEqual(result.introducedFindings, [])
  await assert.rejects(
    fs.access(path.join(f.root, 'package-lock.json')),
    /ENOENT/
  )
})

test('reopening an active native snapshot finalizes locally and persists the interrupted checkpoint', async (t) => {
  const f = await fixture(t)
  await f.store.start(f.record)
  await f.store.charge(f.record, 'repair', 'Interrupted invocation')
  f.record.state = f.state
  await f.store.write(f.record)
  const unavailable = async (): Promise<never> => {
    throw new Error('Unexpected agent work')
  }
  const passthrough = async (state: EpicDomainState) => state
  const mocked: EpicServices = {
    ctx: {} as never,
    now: realClock.now,
    notify: () => undefined,
    classify: (state) => state,
    scout: async (state) => ({
      state,
      report: {
        epicSummary: '',
        relevantFiles: [],
        codeExcerpts: [],
        callPaths: [],
        dataFlow: [],
        existingPatterns: [],
        tests: [],
        verificationCommands: [],
        architectureConstraints: [],
        risks: [],
        uncertainties: [],
      },
    }),
    plan: async (state) => ({ state, result: 'plan' }),
    approvePlan: passthrough,
    reviewPlan: async (state) => ({ state, revised: false }),
    decompose: passthrough,
    prerequisites: async (state) => ({ ...state, prerequisites: [] }),
    preparePrerequisites: passthrough,
    prepareVerification: passthrough,
    implement: async () => new Promise<EpicDomainState>(() => undefined),
    verifyTask: unavailable,
    finalizeTask: unavailable,
    taskDecision: unavailable,
    serve: () => () => undefined,
    browserSmoke: unavailable,
    checks: unavailable,
    review: unavailable,
    reviseTask: unavailable,
    checkpointTask: unavailable,
    recordRecovery: unavailable,
    approveRecovery: unavailable,
  }
  const actor = createActor(createEpicMachine(mocked), {
    input: { state: f.state },
  }).start()
  actor.send({ type: 'EPIC.START' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  actor.send({ type: 'PLAN.APPROVE' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  actor.send({ type: 'TASK.APPROVE' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(actor.getSnapshot().value, 'taskExecution')
  const snapshot = actor.getPersistedSnapshot()
  actor.stop()
  const metadata = {
    epicId: f.state.epicId,
    createdAt: realClock.now(),
    updatedAt: realClock.now(),
  }
  const configuration = await resolveEpicConfiguration(f.root)
  const context = {
    ui: { notify: () => undefined, setStatus: () => undefined },
  } as never
  const runtime = await createEpicRuntime(
    f.state,
    metadata,
    context,
    realClock,
    timer,
    configuration,
    snapshot
  )
  try {
    assert.equal(runtime.boundary().stage, 'awaiting_task_review')
    const report = (await f.store.read()).report
    assert.ok(report)
    assert.match(report.problems.join(' '), /Task interrupted/)
    assert.equal(report.usage.repairs, 1)
    const envelope = await loadActiveEpic(f.root)
    const reopened = await createEpicRuntime(
      runtime.domain(),
      metadata,
      context,
      realClock,
      timer,
      configuration,
      envelope.snapshot
    )
    try {
      assert.equal(reopened.boundary().stage, 'awaiting_task_review')
      assert.equal((await f.store.read()).report?.id, report.id)
    } finally {
      reopened.stop()
    }
    await runtime.dispatchAndSettle({ type: 'EPIC.RESUME' }, undefined)
    assert.equal(
      (await f.store.read()).invocations.filter((i) => i.kind === 'repair')
        .length,
      1
    )
    assert.equal(
      await fs.readFile(path.join(f.root, 'candidate.txt'), 'utf8'),
      'good'
    )
  } finally {
    runtime.stop()
  }
})

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  return address.port
}

test('real browser: verifier corrects a CSS probe without spending an implementation repair', async (t) => {
  const f = await fixture(t, 0)
  const port = await availablePort()
  const fixtures = path.resolve('tests/fixtures')
  await fs.writeFile(path.join(f.root, 'counter.html'), '<main style="margin: 0">Layout</main>')
  const state = {
    ...f.state,
    devServer: {
      command: process.execPath,
      args: [path.join(fixtures, 'acceptance-server.mjs'), String(port)],
      url: `http://127.0.0.1:${port}/`,
      readySelector: 'main',
    },
  }
  const obligation = {
    id: 'layout',
    criterionId: 'T1:AC1',
    expected: 'The main element has no margin',
    method: 'agent_browser' as const,
  }
  f.record.plan = { ...f.plan, obligations: [obligation] }
  await f.store.write(f.record)
  const attempts: BrowserProbe[] = []
  f.dependencies.explore = async (_current, plan, operation) => {
    assert.deepEqual(plan.obligations, [obligation])
    assert.ok(operation.bridge)
    for (const step of [
      { action: 'inspect', expression: "getComputedStyle(document.querySelector('main')).margin === '0'" },
      { action: 'observe', expression: "getComputedStyle(document.querySelector('main')).margin" },
      { action: 'inspect', expression: "['marginTop', 'marginRight', 'marginBottom', 'marginLeft'].every(side => getComputedStyle(document.querySelector('main'))[side] === '0px')" },
    ]) {
      const response: Response = await fetch(operation.bridge.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${operation.bridge.token}` },
        body: JSON.stringify({ obligationId: obligation.id, steps: [step] }),
      })
      assert.equal(response.status, 200)
      attempts.push((await response.json() as BrowserProbeResponse).probe)
    }
    const response = await fetch(new URL('/conclude', operation.bridge.url), {
      method: 'POST', headers: { authorization: `Bearer ${operation.bridge.token}` },
      body: JSON.stringify({ obligationId: obligation.id, conclusion: {
        obligationId: obligation.id, outcome: 'pass', basis: 'observations',
        evidenceIds: [attempts[2].observations[0].id],
        explanation: 'All four computed margin sides are zero pixels.', limitations: [],
      } }),
    })
    assert.equal(response.status, 200, await response.text())
  }
  await runTaskVerification(state, new AbortController().signal, f.dependencies)
  assert.deepEqual(attempts.map(p => p.observations[0]?.passed), [false, undefined, true])
  assert.equal(attempts[1]?.observations[0]?.value, '0px')
  for (const probe of attempts) {
    const artifact = JSON.parse(await fs.readFile(probe.artifact, 'utf8'))
    assert.equal(artifact.id, probe.id)
  }
  const record = await f.store.read()
  assert.equal(record.report?.readiness, 'verified')
  assert.equal(record.cycles.length, 1)
  assert.equal(record.report?.usage.repairs, 0)
  assert.equal(record.cycles[0]?.evidence[0]?.outcome, 'pass')
  assert.equal(record.cycles[0]?.probes?.length, 3)
  assert.deepEqual(f.calls, ['fast', 'full', 'review'])
})

test('real browser: smoke misses interaction defect, acceptance repairs it, and bridge contexts remain isolated', async (t) => {
  const f = await fixture(t)
  const port = await availablePort()
  const fixtures = path.resolve('tests/fixtures')
  await fs.copyFile(
    path.join(fixtures, 'counter-faulty.html'),
    path.join(f.root, 'counter.html')
  )
  const state = {
    ...f.state,
    devServer: {
      command: process.execPath,
      args: [path.join(fixtures, 'acceptance-server.mjs'), String(port)],
      url: `http://127.0.0.1:${port}/`,
      readySelector: 'main',
    },
  }
  assert.ok(state.tasks)
  const firstTask = state.tasks[0]
  assert.ok(firstTask)
  state.tasks[0] = { ...firstTask, requiredChecks: ['browser-smoke'] }
  const obligation = {
    id: 'counter',
    criterionId: 'T1:AC1',
    expected: 'Counter increments once',
    method: 'automated' as const,
    steps: [
      { action: 'click' as const, selector: '#increment', value: '' },
      { action: 'text' as const, selector: '#count', value: '1' },
    ],
  }
  f.record.plan = { ...f.plan, obligations: [obligation] }
  await f.store.write(f.record)
  f.dependencies.repair = async (current) => {
    assert.equal((await f.store.read()).invocations.at(-1)?.kind, 'repair')
    f.calls.push('repair')
    await fs.copyFile(
      path.join(fixtures, 'counter.html'),
      path.join(f.root, 'counter.html')
    )
    return current
  }
  const verified = await runTaskVerification(
    state,
    new AbortController().signal,
    f.dependencies
  )
  const record = await f.store.read()
  assert.equal(
    record.report?.readiness,
    'verified',
    JSON.stringify(record.report?.problems)
  )
  assert.equal(record.cycles[0]?.smoke?.passed, true)
  assert.equal(record.cycles[0]?.evidence[0]?.outcome, 'fail')
  assert.match(
    record.cycles[0]?.evidence[0]?.actual ?? '',
    /Counter interaction defect/
  )
  assert.equal(record.cycles[1]?.evidence[0]?.outcome, 'pass')
  assert.deepEqual(f.calls, [
    'fast',
    'full',
    'review',
    'repair',
    'fast',
    'full',
    'review',
  ])
  const report = record.report
  assert.ok(report)
  const operation: VerificationOperation = {
    signal: new AbortController().signal,
    remainingMs: () => 10_000,
  }
  const browser = await BrowserExecution.open({
    state: verified,
    operation,
    executablePath: undefined,
    maxOutputBytes: 5000,
    artifactRoot: path.dirname(f.store.file),
    identity: report.identity,
    attempt: 3,
    nowMs: () => Date.now(),
  })
  const plan = {
    ...f.record.plan,
    obligations: [{ ...obligation, method: 'agent_browser' as const }],
  }
  const bridge = await openBrowserBridge(browser, plan, { invocationId: 'test-invocation', probes: [], limits: f.dependencies.browserProbeLimits })
  try {
    assert.equal(
      (await fetch(bridge.url, { method: 'POST', body: '{}' })).status,
      403
    )
    for (let i = 0; i < 2; i++) {
      const response = await fetch(bridge.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${bridge.token}` },
        body: JSON.stringify({
          obligationId: 'counter',
          steps: obligation.steps,
        }),
      })
      assert.equal(response.status, 200)
      const probe = (await response.json() as BrowserProbeResponse).probe
      assert.equal(probe.observations[0]?.value, '1')
      const concluded = await fetch(new URL('/conclude', bridge.url), {
        method: 'POST', headers: { authorization: `Bearer ${bridge.token}` },
        body: JSON.stringify({ obligationId: 'counter', conclusion: {
          obligationId: 'counter', outcome: 'pass', basis: 'observations',
          evidenceIds: [probe.observations[0].id], explanation: 'One real click produced count 1 from a fresh page.', limitations: [],
        } }),
      })
      assert.equal(concluded.status, 200)
      const observed = await concluded.json() as AcceptanceEvidence
      const validated = await validateAcceptanceEvidence(
        [observed],
        plan,
        report.identity,
        3,
        path.dirname(f.store.file)
      )
      assert.deepEqual(validated.problems, [])
    }
  } finally {
    await bridge.close()
    await browser.close()
  }
  await assert.rejects(fetch(bridge.url), /fetch failed/)
  const updated = await f.store.read()
  updated.plan = { ...plan, version: 2 }
  await f.store.write(updated)
  let explorations = 0
  f.dependencies.explore = async (_state, _plan, operation, errors) => {
    explorations++
    if (explorations === 1) return // Incomplete verifier output consumes the shared retry.
    assert.ok(errors.some((e) => e.includes('missing valid evidence')))
    assert.ok(operation.bridge)
    const toolBridge = operation.bridge
    const previousUrl = process.env.PI_EPIC_BROWSER_URL
    const previousToken = process.env.PI_EPIC_BROWSER_TOKEN
    process.env.PI_EPIC_BROWSER_URL = operation.bridge.url
    process.env.PI_EPIC_BROWSER_TOKEN = operation.bridge.token
    let executeTool: (() => Promise<void>) | undefined
    try {
      verifierTools({
        registerTool: (tool) => {
          if (tool.name !== 'browser_verify') return
          assert.equal(tool.executionMode, 'sequential')
          executeTool = async () => {
            const result = await tool.execute(
              'verification-tool',
              { obligationId: 'counter', steps: obligation.steps } as never,
              operation.signal,
              undefined,
              { model: { input: ['text', 'image'] } } as never
            )
            assert.equal(result.content[0]?.type, 'text')
            const probe = JSON.parse(result.content[0].text) as BrowserProbe
            const conclusion = await fetch(new URL('/conclude', toolBridge.url), {
              method: 'POST', headers: { authorization: `Bearer ${toolBridge.token}` },
              body: JSON.stringify({ obligationId: 'counter', conclusion: {
                obligationId: 'counter', outcome: 'pass', basis: 'observations', evidenceIds: [probe.observations[0].id],
                explanation: 'Click increments count to 1 on a fresh page.', limitations: [],
              } }),
            })
            assert.equal(conclusion.status, 200)
          }
        },
      } as ExtensionAPI)
      assert.ok(executeTool)
      await executeTool()
    } finally {
      if (previousUrl === undefined) delete process.env.PI_EPIC_BROWSER_URL
      else process.env.PI_EPIC_BROWSER_URL = previousUrl
      if (previousToken === undefined) delete process.env.PI_EPIC_BROWSER_TOKEN
      else process.env.PI_EPIC_BROWSER_TOKEN = previousToken
    }
  }
  await runTaskVerification(
    verified,
    new AbortController().signal,
    f.dependencies
  )
  const agentVerified = await f.store.read()
  assert.equal(explorations, 2)
  assert.equal(agentVerified.report?.readiness, 'verified')
  assert.equal(
    agentVerified.invocations.filter((i) => i.kind === 'repair').length,
    1
  )
  assert.equal(
    agentVerified.invocations.filter((i) => i.kind === 'infrastructure').length,
    1
  )
})

test('real browser: adaptive canvas images, held keys, timed frames and explicit conclusions', async t => {
  const f = await fixture(t, 0)
  const port = await availablePort()
  await fs.writeFile(path.join(f.root, 'counter.html'), `
    <main><canvas width="160" height="100" tabindex="0"></canvas></main>
    <script>
      window.x = 20; const canvas = document.querySelector('canvas');
      const context = canvas.getContext('2d');
      function draw() { context.fillStyle = '#101020'; context.fillRect(0, 0, 160, 100);
        context.fillStyle = '#ff0000'; context.fillRect(window.x, 60, 20, 10); }
      document.addEventListener('keydown', e => { if(e.key === 'ArrowRight') { window.x += 30; draw(); } }); draw();
    </script>`)
  const state = { ...f.state, devServer: { command: process.execPath,
    args: [path.resolve('tests/fixtures/acceptance-server.mjs'), String(port)], url: `http://127.0.0.1:${port}/`, readySelector: 'canvas' } }
  const obligation = { id: 'paddle', criterionId: 'T1:AC1', expected: 'Right moves the red paddle right', method: 'agent_browser' as const }
  f.record.plan = { ...f.plan, obligations: [obligation] }
  await f.store.write(f.record)
  f.dependencies.explore = async (_state, _plan, operation) => {
    assert.ok(operation.bridge)
    const oldUrl = process.env.PI_EPIC_BROWSER_URL, oldToken = process.env.PI_EPIC_BROWSER_TOKEN
    process.env.PI_EPIC_BROWSER_URL = operation.bridge.url
    process.env.PI_EPIC_BROWSER_TOKEN = operation.bridge.token
    const tools = new Map<string, ToolDefinition>()
    try {
      verifierTools({ registerTool: tool => { tools.set(tool.name, tool as unknown as ToolDefinition) } } as ExtensionAPI)
      const verify = tools.get('browser_verify'), conclude = tools.get('browser_conclude')
      assert.ok(verify && conclude)
      const ctx = { model: { input: ['text', 'image'] } } as never
      const result = await verify.execute('probe', { obligationId: 'paddle', steps: [
        { action: 'observe', expression: 'window.x' },
        { action: 'capture', selector: 'canvas', count: 1, intervalMs: 0 },
        { action: 'key_down', key: 'ArrowRight' }, { action: 'wait', durationMs: 30 }, { action: 'key_up', key: 'ArrowRight' },
        { action: 'observe', expression: 'window.x' },
        { action: 'capture', selector: 'canvas', count: 2, intervalMs: 40 },
      ] } as never, operation.signal, undefined, ctx)
      const probe = result.details as BrowserProbe
      assert.deepEqual(probe.observations.map(o => o.value), [20, 50])
      assert.equal(probe.images.length, 3)
      assert.ok(probe.images.every(i => i.width === 160 && i.height === 100 && i.selector === 'canvas'))
      assert.ok(probe.images[2].timestamp > probe.images[1].timestamp)
      const images = result.content.filter(c => c.type === 'image')
      assert.equal(images.length, 3)
      assert.ok(images.every(i => Buffer.from(i.data, 'base64').subarray(1, 4).toString() === 'PNG'))
      assert.notEqual(images[0].data, images[1].data)
      assert.ok(!JSON.stringify(result.details).includes(images[0].data))
      // Repeating a probe repeats setup on a fresh page: the old x=50 is gone.
      const fresh = await verify.execute('fresh', { obligationId: 'paddle', steps: [
        { action: 'observe', expression: 'window.x' }, { action: 'capture', count: 1, intervalMs: 0 },
      ] } as never, operation.signal, undefined, ctx)
      const freshProbe = fresh.details as BrowserProbe
      assert.equal(freshProbe.observations[0].value, 20)
      assert.equal(freshProbe.images[0].selector, undefined)
      assert.equal(freshProbe.images[0].width, 1280)
      // Images and measured motion belong to the earlier single execution, still available by evidence ID.
      const conclusion = await conclude.execute('conclude', {
        obligationId: 'paddle', outcome: 'pass', basis: 'motion',
        evidenceIds: [...probe.observations.map(o => o.id), ...probe.images.map(i => i.id)],
        explanation: 'The real ArrowRight input moved x from 20 to 50, confirmed by the red paddle shifting right in the captured canvas.',
        temporalComparison: 'Before and after input on the same fresh page, x increased by 30 and the red paddle moved right.', limitations: [],
      } as never, operation.signal, undefined, ctx)
      assert.equal((conclusion.details as AcceptanceEvidence).outcome, 'pass')
    } finally {
      if (oldUrl === undefined) delete process.env.PI_EPIC_BROWSER_URL
      else process.env.PI_EPIC_BROWSER_URL = oldUrl
      if (oldToken === undefined) delete process.env.PI_EPIC_BROWSER_TOKEN
      else process.env.PI_EPIC_BROWSER_TOKEN = oldToken
    }
  }
  await runTaskVerification(state, new AbortController().signal, f.dependencies)
  const record = await f.store.read()
  assert.equal(record.report?.readiness, 'verified', JSON.stringify(record.report?.problems))
  assert.equal(record.cycles[0].probes?.length, 2)
  assert.match(reviewReportMarkdown(record.report as NonNullable<typeof record.report>), /Temporal comparison/)
})

test('real browser: deadline cancellation closes a probe evaluating a never-resolving expression', async t => {
  const f = await fixture(t, 0)
  const port = await availablePort()
  await fs.writeFile(path.join(f.root, 'counter.html'), '<main>Ready</main>')
  const controller = new AbortController()
  const operation = { signal: controller.signal, remainingMs: () => { controller.signal.throwIfAborted(); return 5000 } }
  const browser = await BrowserExecution.open({ state: { ...f.state, devServer: {
    command: process.execPath, args: [path.resolve('tests/fixtures/acceptance-server.mjs'), String(port)],
    url: `http://127.0.0.1:${port}/`, readySelector: 'main',
  } }, operation, executablePath: undefined, maxOutputBytes: 5000,
    artifactRoot: path.dirname(f.store.file), identity: 'cancel-cycle', attempt: 1, nowMs: () => Date.now() })
  try {
    const timeout = setTimeout(() => controller.abort(new Error('Deadline exhausted')), 300)
    const probe = await browser.probe({ id: 'cancel', criterionId: 'T1:AC1', expected: 'Observe result', method: 'agent_browser' },
      [{ action: 'observe', expression: 'new Promise(() => {})' }], 'cancel-invocation', f.dependencies.browserProbeLimits)
    clearTimeout(timeout)
    assert.ok(probe.probeErrors.length)
    assert.equal(browser.browser.contexts().length, 0)
    assert.equal((JSON.parse(await fs.readFile(probe.artifact, 'utf8')) as BrowserProbe).id, probe.id)
  } finally { await browser.close() }
})

async function manualFixture(t: TestContext) {
  const f = await fixture(t, 0)
  assert.ok(f.state.tasks)
  f.state.tasks[0].manualReviewSteps = ['Inspect the field', 'Compare arrow and A/D paddle movement']
  const state = await runTaskVerification(f.state, new AbortController().signal, f.dependencies)
  const review = (await f.store.read()).manualReviews.at(-1)
  assert.ok(review)
  const update = (index: number, status: 'passed' | 'failed' | 'not_checked', observation = '') => decideTask(state, {
    kind: 'update_manual_review', identity: review.identity, reportId: review.reportId,
    itemId: review.items[index].id, status, observation, reason: 'Human review',
  }, realClock)
  return { ...f, state, review, update }
}

test('manual checklist persists edits, blocks ordinary approval, and resets only for a new report', async t => {
  const f = await manualFixture(t)
  assert.deepEqual(f.review.items.map(i => i.status), ['not_checked', 'not_checked'])
  assert.ok(f.state.lastVerificationReportPath)
  const immutableReport = await fs.readFile(f.state.lastVerificationReportPath, 'utf8')
  await assert.rejects(decideTask(f.state, { kind: 'approve' }, realClock), /Ordinary approval/)
  await f.update(0, 'passed')
  await f.update(1, 'failed', 'A/D do not move the paddle')
  const reopened = await new VerificationStore(f.store.file, realClock).read()
  assert.deepEqual(reopened.manualReviews[0].items.map(i => i.status), ['passed', 'failed'])
  assert.equal(reopened.manualReviews[0].items[1].observation, 'A/D do not move the paddle')
  assert.equal(await fs.readFile(f.state.lastVerificationReportPath, 'utf8'), immutableReport)
  await assert.rejects(decideTask(f.state, { kind: 'approve' }, realClock), /Ordinary approval/)
  await f.update(1, 'passed')
  const accepted = await decideTask(f.state, { kind: 'approve' }, realClock)
  await assertAcceptedReport(accepted, realClock)
  await f.update(1, 'not_checked')
  await assert.rejects(assertAcceptedReport(accepted, realClock), /manual review/)
  await runTaskVerification(f.state, new AbortController().signal, f.dependencies)
  const next = await f.store.read()
  assert.equal(next.manualReviews.length, 2)
  assert.deepEqual(next.manualReviews[1].items.map(i => i.status), ['not_checked', 'not_checked'])
  assert.equal(next.manualReviews[0].items[1].status, 'not_checked')
  await assert.rejects(f.update(0, 'passed'), /current attempt\/report/)
})

test('human failure on a verified report reaches implementation before checks and consumes one explicit repair', async t => {
  const f = await manualFixture(t)
  await f.update(0, 'passed')
  await f.update(1, 'failed', 'A/D do not move the paddle')
  // Plain reverification must not submit this feedback to an implementer.
  const calls: string[] = []
  const dependencies = { ...f.dependencies,
    repair: async (state: EpicDomainState, feedback: string) => {
      assert.match(feedback, /Compare arrow and A\/D paddle movement/)
      assert.match(feedback, /A\/D do not move the paddle/)
      const charged = await f.store.read()
      assert.equal(charged.invocations.filter(i => i.kind === 'repair').length, 1)
      assert.ok(charged.humanRepairRequests[0].invocationId)
      calls.push('human repair')
      return state
    },
    checks: async (...args: Parameters<VerificationDependencies['checks']>) => {
      calls.push(args[1]); return f.dependencies.checks(...args)
    },
  }
  const record = await f.store.read()
  const granted = await decideTask(f.state, latestTaskRepairRequest(record.report, { repairs: 1, timeMs: 300_000 }, true), realClock)
  const nextState = await runTaskVerification(granted, new AbortController().signal, dependencies)
  assert.deepEqual(calls, ['human repair', 'fast', 'full'])
  const after = await f.store.read()
  assert.equal(after.humanRepairRequests[0].completed, true)
  assert.equal(after.invocations.filter(i => i.kind === 'repair').length, 1)
  assert.equal(after.report?.readiness, 'verified')
  assert.deepEqual(after.manualReviews.at(-1)?.items.map(i => i.status), ['not_checked', 'not_checked'])
  assert.equal(after.manualReviews[0].items[1].status, 'failed')
  await assert.rejects(decideTask(nextState, { kind: 'approve' }, realClock), /Ordinary approval/)
})

test('resume never submits ungranted manual failures, and unchecked items alone cannot grant a repair', async t => {
  const f = await manualFixture(t)
  const record = await f.store.read()
  const grant = { kind: 'grant' as const, identity: f.review.identity, reportId: f.review.reportId, repairs: 1, timeMs: 300_000, reason: 'Repair' }
  await assert.rejects(decideTask(f.state, grant, realClock), /already verified/)
  await f.update(1, 'failed', 'A/D do not work')
  let repairs = 0
  await runTaskVerification(f.state, new AbortController().signal, { ...f.dependencies, repair: async state => { repairs++; return state } })
  assert.equal(repairs, 0)
  assert.equal((await f.store.read()).grants.length, record.grants.length)
})

test('evidence gaps offer manual review without repair; a recorded manual defect enables repair', async t => {
  const f = await manualFixture(t)
  for (const gap of ['blocked', 'not_attempted', 'inconclusive'] as const) {
    const record = await f.store.read()
    const cycle = record.cycles.at(-1)
    assert.ok(cycle)
    cycle.evidence = cycle.evidence.map(e => ({ ...e, outcome: 'inconclusive', gap, actual: `Verification ${gap}` }))
    const report = { ...constructReviewReport(record, f.review.identity, f.store.remaining(record)), id: f.review.reportId }
    assert.equal(report.readiness, 'needs_manual_confirmation')
    record.report = report
    await f.store.write(record)
    const state = { ...f.state, verificationReadiness: report.readiness }
    const dashboard = () => projectDashboardState({
      domain: state, metadata: { epicId: state.epicId, createdAt: realClock.now(), updatedAt: realClock.now() },
      boundary: { stage: 'awaiting_task_review', wait: 'awaiting-human' }, events: [], agentProfiles: [], verificationRecord: record,
    }).actionRequired
    assert.doesNotMatch(dashboard()?.message ?? '', /\/task-repair/)
    assert.ok(!dashboard()?.actions.some(a => a.command === '/task-repair'))
    assert.ok(!dashboard()?.actions.some(a => a.command === '/epic-resume'))
    assert.doesNotMatch(dashboard()?.message ?? '', /Reverify|task-accept|limitations/)
    assert.equal(dashboard()?.actions[0]?.disabled, true)
    assert.doesNotMatch(reviewReportMarkdown(report), /\/task-repair/)
    assert.doesNotMatch(reviewReportMarkdown(report), /Reverify/)
    assert.throws(() => latestTaskRepairRequest(report, { repairs: 1, timeMs: 300_000 }, false), /No actionable failure/)
    await assert.rejects(decideTask(state, {
      kind: 'grant', identity: report.identity, reportId: report.id, repairs: 1, timeMs: 300_000, reason: 'Try again',
    }, realClock), /No actionable failure/)
    assert.deepEqual(await f.store.read(), record)
  }
  await f.update(1, 'failed', 'A/D do not move the paddle')
  const record = await f.store.read()
  const report = record.report
  assert.ok(report)
  const dashboard = projectDashboardState({
    domain: { ...f.state, verificationReadiness: report.readiness },
    metadata: { epicId: f.state.epicId, createdAt: realClock.now(), updatedAt: realClock.now() },
    boundary: { stage: 'awaiting_task_review', wait: 'awaiting-human' }, events: [], agentProfiles: [], verificationRecord: record,
  }).actionRequired
  assert.ok(dashboard?.actions.some(a => a.command === '/task-repair'))
  assert.match(dashboard?.message ?? '', /recorded observations/)
  await decideTask(f.state, latestTaskRepairRequest(report, { repairs: 1, timeMs: 300_000 }, true), realClock)
  assert.match((await f.store.read()).humanRepairRequests[0].feedback, /A\/D do not move the paddle/)
})

test('historical limitations decisions remain audit data and cannot authorize checkpoints', async t => {
  const f = await manualFixture(t)
  await f.update(1, 'failed', 'A/D do not work')
  const record = await f.store.read()
  const historical = {
    kind: 'accept_unresolved' as const, identity: f.review.identity, reportId: f.review.reportId,
    obligations: f.review.items.map(item => item.id), reason: 'Past acceptance', at: realClock.nowMs(),
  }
  record.decisions.push(historical)
  await f.store.write(record)
  assert.deepEqual((await f.store.read()).decisions.at(-1), historical)
  await assert.rejects(assertAcceptedReport(f.state, realClock), /Checkpoint requires acceptance/)
  await assert.rejects(decideTask(f.state, JSON.parse(JSON.stringify(historical)), realClock), /Unsupported task decision/)
  await assert.rejects(decideTask(f.state, { kind: 'approve' }, realClock), /resolve actionable failures/)
  await f.update(0, 'passed')
  await f.update(1, 'passed')
  const approved = await decideTask(f.state, { kind: 'approve' }, realClock)
  await assertAcceptedReport(approved, realClock)
  const saved = await f.store.read()
  assert.deepEqual(saved.decisions[0], historical)
  assert.equal(saved.decisions.at(-1)?.kind, 'approve')
})

test('completed manual review approves evidence gaps directly and checkpoints the saved decision', async t => {
  const f = await manualFixture(t)
  const record = await f.store.read()
  const cycle = record.cycles.at(-1)
  assert.ok(cycle)
  cycle.evidence = cycle.evidence.map(e => ({ ...e, outcome: 'inconclusive', gap: 'inconclusive', actual: 'Canvas content could not be inspected.' }))
  cycle.problems = ['Verifier could not establish the expected outcome.']
  record.report = { ...constructReviewReport(record, f.review.identity, f.store.remaining(record)), id: f.review.reportId }
  const report = structuredClone(record.report)
  assert.equal(report.readiness, 'needs_manual_confirmation')
  await f.store.write(record)
  await assert.rejects(decideTask(f.state, { kind: 'approve' }, realClock), /Complete all manual steps/)
  await f.update(0, 'passed')
  assert.equal(manualReviewSubmission(await f.store.read()).kind, 'incomplete')
  await f.update(1, 'passed')
  assert.equal(manualReviewSubmission(await f.store.read()).kind, 'approve')
  const state = { ...f.state, verificationReadiness: report.readiness }
  const dashboard = projectDashboardState({
    domain: state, metadata: { epicId: state.epicId, createdAt: realClock.now(), updatedAt: realClock.now() },
    boundary: { stage: 'awaiting_task_review', wait: 'awaiting-human' }, events: [], agentProfiles: [], verificationRecord: await f.store.read(),
  }).actionRequired
  assert.equal(dashboard?.actions[0]?.label, 'Continue (approve task)')
  assert.equal(dashboard?.actions[0]?.disabled, false)
  assert.match(dashboard?.message ?? '', /All manual review steps passed/)
  assert.doesNotMatch(dashboard?.message ?? '', /limitations|task-accept/)
  const approved = await decideTask(state, { kind: 'approve' }, realClock)
  assert.equal(approved.taskApproved, true)
  assert.deepEqual(await assertAcceptedReport(approved, realClock), report)
  const saved = await f.store.read()
  assert.deepEqual(saved.report, report)
  assert.equal(saved.decisions.at(-1)?.kind, 'approve')
  assert.deepEqual(saved.decisions.at(-1)?.obligations, report.unresolved)
  assert.match(saved.decisions.at(-1)?.reason ?? '', /manual review steps passed/)
  await f.update(0, 'not_checked')
  await assert.rejects(assertAcceptedReport(approved, realClock), /all manual review items/)
  await f.update(0, 'passed')
  saved.report = { ...report, readiness: 'issues_remaining' }
  saved.manualReviews = (await f.store.read()).manualReviews
  await f.store.write(saved)
  assert.equal(manualReviewSubmission(await f.store.read()).kind, 'grant')
  await assert.rejects(decideTask(state, { kind: 'approve' }, realClock), /resolve actionable failures/)
  await assert.rejects(assertAcceptedReport(approved, realClock), /no actionable failures/)
})

test('invalid manual updates and failed writes retain the previous saved status', async t => {
  const f = await manualFixture(t)
  await assert.rejects(f.update(1, 'failed'), /observation/)
  const before = await fs.readFile(f.store.file, 'utf8')
  const original = VerificationStore.prototype.write
  const mock = t.mock.method(VerificationStore.prototype, 'write', async function(this: VerificationStore, ...args: Parameters<VerificationStore['write']>) {
    if (this.file === f.store.file) throw new Error('disk full')
    return original.apply(this, args)
  })
  await assert.rejects(f.update(0, 'passed'), /disk full/)
  mock.mock.restore()
  assert.equal(await fs.readFile(f.store.file, 'utf8'), before)
})

test('interrupted human repair remains charged; plain resume cannot repeat it, and a fresh grant can', async t => {
  const f = await manualFixture(t)
  await f.update(1, 'failed', 'A/D do not work')
  await decideTask(f.state, latestTaskRepairRequest((await f.store.read()).report, { repairs: 1, timeMs: 300_000 }, true), realClock)
  let calls = 0
  const dependencies = { ...f.dependencies, repair: async () => { calls++; throw new Error('Interrupted human repair') } }
  const interrupted = await runTaskVerification(f.state, new AbortController().signal, dependencies)
  let record = await f.store.read()
  assert.equal(calls, 1)
  assert.ok(record.humanRepairRequests[0].invocationId)
  assert.equal(record.humanRepairRequests[0].completed, false)
  await runTaskVerification(interrupted, new AbortController().signal, dependencies)
  assert.equal(calls, 1)
  record = await f.store.read()
  const current = record.manualReviews.at(-1)
  assert.ok(current)
  await decideTask(interrupted, { kind: 'update_manual_review', identity: current.identity, reportId: current.reportId, itemId: current.items[1].id, status: 'failed', observation: 'Still broken', reason: 'Retest' }, realClock)
  await decideTask(interrupted, latestTaskRepairRequest(record.report, { repairs: 1, timeMs: 300_000 }, true), realClock)
  await runTaskVerification(interrupted, new AbortController().signal, { ...dependencies, repair: async state => { calls++; return state } })
  assert.equal(calls, 2)
  record = await f.store.read()
  assert.equal(record.invocations.filter(i => i.kind === 'repair').length, 2)
  assert.equal(record.humanRepairRequests[1].completed, true)
})

test('dashboard continues after manual review without limitation dialogs', async t => {
  const f = await manualFixture(t)
  const actions = async () => {
    const record = await f.store.read()
    return projectDashboardState({ domain: f.state, metadata: { epicId: f.state.epicId, createdAt: realClock.now(), updatedAt: realClock.now() }, boundary: { stage: 'awaiting_task_review', wait: 'awaiting-human' }, events: [], agentProfiles: [], verificationRecord: record }).actionRequired?.actions
  }
  const unchecked = await actions()
  assert.equal(unchecked?.[0]?.id, 'manual-review-submit')
  assert.equal(unchecked?.[0]?.label, 'Continue (complete manual review)')
  assert.ok(unchecked?.[0]?.manualReview)
  assert.ok(!unchecked?.some(a => ['task-approve', 'task-repair', 'task-accept'].includes(a.id)))
  assert.equal(manualReviewSubmission(await f.store.read()).kind, 'incomplete')
  await f.update(0, 'passed')
  assert.equal((await actions())?.[0]?.label, 'Continue (complete manual review)')
  await f.update(0, 'not_checked')
  await f.update(1, 'failed', 'A/D do not work')
  assert.equal((await actions())?.[0]?.label, 'Continue (request fixes)')
  assert.ok((await actions())?.some(a => a.command === '/task-repair'))
  assert.equal(manualReviewSubmission(await f.store.read()).kind, 'grant')
  await f.update(0, 'passed')
  await f.update(1, 'passed')
  const passed = await actions()
  assert.equal(passed?.[0]?.id, 'manual-review-submit')
  assert.equal(passed?.[0]?.label, 'Continue (approve task)')
  assert.ok(!passed?.some(a => a.command === '/task-repair'))
  assert.equal(manualReviewSubmission(await f.store.read()).kind, 'approve')
  const automatedFailure = await f.store.read()
  assert.ok(automatedFailure.report)
  automatedFailure.report.readiness = 'issues_remaining'
  automatedFailure.report.unresolved = ['T1:AC1']
  await f.store.write(automatedFailure)
  assert.equal((await actions())?.[0]?.label, 'Continue (request fixes)')
  assert.ok((await actions())?.some(a => a.command === '/task-repair'))
  assert.match(reviewReportMarkdown(automatedFailure.report), /\/task-repair/)
  assert.equal(manualReviewSubmission(await f.store.read()).kind, 'grant')
  await f.update(0, 'failed', 'Rendering is broken')
  assert.equal((await actions())?.[0]?.label, 'Continue (request fixes)')
  assert.equal(manualReviewSubmission(await f.store.read()).kind, 'grant')
})


test('likely failures block completed manual approval without authorizing repair', async t => {
  const f = await manualFixture(t)
  const record = await f.store.read()
  const cycle = record.cycles.at(-1)
  assert.ok(cycle)
  cycle.evidence = cycle.evidence.map(e => ({
    ...e, outcome: 'likely-fail',
    suspectedFailure: {
      contradiction: 'Paddle remained centered after held inputs.',
      uncertainty: 'Keyboard delivery is uncertain.',
      confirmationCheck: 'Focus the canvas and measure key state and paddle position.',
    },
  }))
  const report = { ...constructReviewReport(record, f.review.identity, f.store.remaining(record)), id: f.review.reportId }
  record.report = report
  assert.equal(report.readiness, 'needs_manual_confirmation')
  assert.ok(report.unresolved.length)
  assert.match(reviewReportMarkdown(report), /Confirmation check: Focus the canvas/)
  await f.store.write(record)
  await f.update(0, 'passed')
  await f.update(1, 'passed')
  assert.deepEqual(manualReviewSubmission(await f.store.read()), { kind: 'incomplete', label: 'Continue (resolve likely failure)' })
  await assert.rejects(decideTask(f.state, { kind: 'approve' }, realClock), /likely failures/)
  await assert.rejects(decideTask(f.state, {
    kind: 'grant', identity: report.identity, reportId: report.id, repairs: 1, timeMs: 300_000, reason: 'Suspected defect',
  }, realClock), /No actionable failure/)
  await f.update(1, 'failed', 'Confirmed: paddle does not respond with canvas focused.')
  assert.equal(manualReviewSubmission(await f.store.read()).kind, 'grant')
})

test('likely failure alone never consumes an automatic repair attempt', async t => {
  const f = await fixture(t)
  await runTaskVerification(f.state, new AbortController().signal, {
    ...f.dependencies,
    review: async (state, cycle) => {
      const evidence = cycle.evidence[0]
      evidence.outcome = 'likely-fail'
      evidence.suspectedFailure = {
        contradiction: 'Observed behavior contradicts the expectation.',
        uncertainty: 'Input delivery is uncertain.',
        confirmationCheck: 'Measure received input and resulting state together.',
      }
      return f.dependencies.review(state, cycle, { signal: new AbortController().signal, remainingMs: () => 30_000 })
    },
  })
  const record = await f.store.read()
  assert.equal(record.report?.readiness, 'needs_manual_confirmation')
  assert.equal(record.cycles.length, 1)
  assert.ok(!f.calls.includes('repair'))
  assert.equal(record.invocations.filter(i => i.kind === 'repair').length, 0)
})


test('legacy unverified ledger evidence is rejected without conversion', async t => {
  const f = await fixture(t)
  await runTaskVerification(f.state, new AbortController().signal, f.dependencies)
  const saved = JSON.parse(await fs.readFile(f.store.file, 'utf8'))
  saved.cycles[0].evidence[0].outcome = 'unverified'
  const legacy = JSON.stringify(saved)
  await fs.writeFile(f.store.file, legacy)
  await assert.rejects(f.store.read(), /Incompatible task verification evidence outcome: unverified.*no migration/)
  assert.equal(await fs.readFile(f.store.file, 'utf8'), legacy)
})
