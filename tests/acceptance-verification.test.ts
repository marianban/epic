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
import { resolveEpicConfiguration } from '../pi/extensions/epic/configuration.ts'
import verifierTools from '../pi/extensions/epic/verifier-tools.ts'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { runCheckSuite } from '../pi/extensions/epic/checks.ts'
import { createActor } from 'xstate'
import { createEpicMachine } from '../pi/extensions/epic/machines/epic-machine.ts'
import { createEpicRuntime } from '../pi/extensions/epic/runtime.ts'
import type { EpicServices } from '../pi/extensions/epic/services.ts'
import { loadActiveEpic } from '../pi/extensions/epic/persistence.ts'
import { constructReviewReport } from '../pi/extensions/epic/verification-report.ts'
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

test('latest-report repair grant resumes an exhausted task and repairs its observed defect', async (t) => {
  const f = await fixture(t, 0)
  await fs.writeFile(path.join(f.root, 'candidate.txt'), 'bad')
  const state = await runTaskVerification(f.state, new AbortController().signal, f.dependencies)
  const before = await f.store.read()
  assert.equal(before.report?.readiness, 'issues_remaining')
  const granted = await decideTask(state, latestTaskRepairRequest(
    before.report, { repairs: 1, timeMs: 300_000 }
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
  assert.equal(invocations, 3)
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

test('human confirmation and unresolved acceptance retain attempt-bound evidence', async (t) => {
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
  const confirmed = await decideTask(
    state,
    {
      kind: 'confirm',
      identity: report.identity,
      reportId: report.id,
      obligations: ['visual'],
      reason: 'I checked the appearance.',
    },
    realClock
  )
  assert.equal(confirmed.verificationReadiness, 'verified')
  await decideTask(confirmed, { kind: 'approve' }, realClock)
  await fs.writeFile(path.join(f.root, 'candidate.txt'), 'bad')
  f.record.plan = f.plan
  f.record.repairsLimit = 0
  await f.store.write(f.record)
  const failed = await runTaskVerification(
    f.state,
    new AbortController().signal,
    f.dependencies
  )
  const failedReport = (await f.store.read()).report
  assert.ok(failedReport)
  await assert.rejects(
    decideTask(
      failed,
      {
        kind: 'accept_unresolved',
        identity: failedReport.identity,
        reportId: failedReport.id,
        obligations: [],
        reason: 'Proceed',
      },
      realClock
    ),
    /Acknowledge every/
  )
  const accepted = await decideTask(
    failed,
    {
      kind: 'accept_unresolved',
      identity: failedReport.identity,
      reportId: failedReport.id,
      obligations: failedReport.unresolved,
      reason: 'Known defect accepted.',
    },
    realClock
  )
  await assertAcceptedReport(accepted, realClock)
  assert.equal((await f.store.read()).report?.criteria[0]?.status, 'not_met')
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
  const bridge = await openBrowserBridge(browser, plan)
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
      const observed = (await response.json()) as AcceptanceEvidence
      assert.equal(observed.outcome, 'pass')
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
    const previousUrl = process.env.PI_EPIC_BROWSER_URL
    const previousToken = process.env.PI_EPIC_BROWSER_TOKEN
    process.env.PI_EPIC_BROWSER_URL = operation.bridge.url
    process.env.PI_EPIC_BROWSER_TOKEN = operation.bridge.token
    let executeTool: (() => Promise<void>) | undefined
    try {
      verifierTools({
        registerTool: (tool) => {
          executeTool = async () => {
            const result = await tool.execute(
              'verification-tool',
              { obligationId: 'counter', steps: obligation.steps } as never,
              operation.signal,
              undefined,
              {} as never
            )
            assert.equal(result.content[0]?.type, 'text')
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
