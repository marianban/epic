import { reviewFailures, isFailureDismissed } from './failure-review.ts'
import type { BrowserProbeLimits } from './browser-evidence-types.ts'
import { summarizeVerificationCycle } from './verification-summary.ts'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  EpicClock,
  EpicTimer,
  EpicDomainState,
  CheckSuiteResult,
  ReviewResult,
} from './types.ts'
import type {
  VerificationOperation,
  VerificationCycle,
  AcceptanceEvidence,
  VerificationPlan,
} from './verification-types.ts'
import {
  VerificationStore,
  taskVerificationPath,
} from './verification-store.ts'
import { validateAcceptanceEvidence } from './acceptance-validation.ts'
import { BrowserExecution } from './browser-execution.ts'
import { openBrowserBridge } from './browser-bridge.ts'
import { verifyCommand } from './verification-command.ts'
import { finalizeReviewReport } from './verification-report.ts'
import { persistImmutableJsonArtifact } from './persistence.ts'

export interface VerificationDependencies {
  clock: EpicClock
  timer: EpicTimer
  executablePath: string | undefined
  maxOutputBytes: number
  browserProbeLimits: BrowserProbeLimits
  checks(
    state: EpicDomainState,
    suite: 'fast' | 'full',
    operation: VerificationOperation
  ): Promise<{ state: EpicDomainState; result: CheckSuiteResult }>
  review(
    state: EpicDomainState,
    cycle: VerificationCycle,
    operation: VerificationOperation
  ): Promise<{ state: EpicDomainState; result: ReviewResult }>
  repair(
    state: EpicDomainState,
    feedback: string,
    operation: VerificationOperation
  ): Promise<EpicDomainState>
  explore(
    state: EpicDomainState,
    plan: VerificationPlan,
    operation: VerificationOperation,
    errors: string[]
  ): Promise<void>
}

export async function runTaskVerification(
  initial: EpicDomainState,
  externalSignal: AbortSignal,
  dependencies: VerificationDependencies
): Promise<EpicDomainState> {
  let state = initial
  const store = new VerificationStore(
    taskVerificationPath(state),
    dependencies.clock
  )
  const record = await store.read()
  // A mixed human decision authorizes the requested repair, then a fresh report.
  // Do not let automatic retries undo findings the user explicitly accepted.
  const hasDismissedFindings = !!record.report && reviewFailures(record).some(isFailureDismissed)
  const interruptedRepair = [...record.invocations]
    .reverse()
    .find((i) => i.kind === 'repair')
  const repairAfterInterruptionGranted =
    !interruptedRepair ||
    interruptedRepair.completed ||
    record.grants.some((g) => g.afterInvocationId === interruptedRepair.id)
  await store.start(record)
  const controller = new AbortController()
  const signal = AbortSignal.any([externalSignal, controller.signal])
  const operation: VerificationOperation = {
    signal,
    remainingMs: () => {
      signal.throwIfAborted()
      const remaining = store.remaining(record)
      if (remaining <= 0)
        throw new Error('Task verification deadline exhausted.')
      return remaining
    },
  }
  const timer = dependencies.timer.setTimeout(
    () => controller.abort(new Error('Task verification deadline exhausted.')),
    Math.max(1, store.remaining(record))
  )
  const root = path.dirname(store.file)
  let identity = randomUUID()
  const errorText = (error: unknown) =>
    error instanceof Error ? error.message : String(error)
  const retry = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      operation.remainingMs()
      return await work()
    } catch (error) {
      signal.throwIfAborted()
      if (
        store.remaining(record) <= 0 ||
        record.invocations.filter((i) => i.kind === 'infrastructure').length >=
          record.infrastructureLimit
      )
        throw error
      const id = await store.charge(record, 'infrastructure', errorText(error))
      const result = await work()
      const invocation = record.invocations.find((i) => i.id === id)
      if (!invocation)
        throw new Error('Charged infrastructure invocation disappeared.', {
          cause: error,
        })
      invocation.completed = true
      await store.write(record)
      return result
    }
  }
  try {
    if (!record.plan)
      throw new Error(
        'Acceptance verification blocked: no independently validated scenario plan.'
      )
    const plan = record.plan
    const pending = record.humanRepairRequests.find(r => !r.completed && !r.invocationId)
    if (pending) {
      if (!repairAfterInterruptionGranted) throw new Error('Interrupted repair requires an explicit additional grant.')
      const invocationId = await store.charge(record, 'repair', pending.feedback, pending)
      state = await dependencies.repair(state, pending.feedback, operation)
      record.state = state
      const invocation = record.invocations.find(i => i.id === invocationId)
      if (!invocation) throw new Error('Charged human repair invocation disappeared.')
      invocation.completed = true
      pending.completed = true
      await store.write(record)
    }
    while (store.remaining(record) > 0 && !signal.aborted) {
      identity = randomUUID()
      const cycle: VerificationCycle = {
        id: randomUUID(),
        identity,
        attempt: record.cycles.length + 1,
        evidence: [],
        problems: [],
        artifacts: [
          ...record.plans.map((p) => p.artifact),
          ...(state.lastDiffPath ? [state.lastDiffPath] : []),
        ],
        state,
        plan,
      }
      record.cycles.push(cycle)
      await store.write(record)
      verificationStages: try {
        for (const suite of ['fast', 'full'] as const) {
          try {
            const checked = await retry(() =>
              dependencies.checks(state, suite, operation)
            )
            state = checked.state
            cycle[suite] = checked.result
            cycle.state = state
            if (state.lastCheckResultPath)
              cycle.artifacts.push(state.lastCheckResultPath)
          } catch (error) {
            cycle.problems.push(`${suite}: ${errorText(error)}`)
          }
          await store.write(record)
          // Repair a failed stage before spending allowance on later stages.
          // Every repair starts a fresh cycle, invalidating earlier check results.
          if (!cycle[suite]?.passed) break verificationStages
        }
        let browser: BrowserExecution | undefined
        const browserRequired =
          state.tasks?.[state.currentTaskIndex]?.requiredChecks.includes(
            'browser-smoke'
          ) === true ||
          plan.obligations.some((o) => o.steps || o.method === 'agent_browser')
        try {
          if (browserRequired) {
            try {
              browser = await retry(() =>
                BrowserExecution.open({
                  state,
                  operation,
                  executablePath: dependencies.executablePath,
                  maxOutputBytes: dependencies.maxOutputBytes,
                  artifactRoot: root,
                  identity,
                  attempt: cycle.attempt,
                  nowMs: () => dependencies.clock.nowMs(),
                })
              )
              cycle.smoke = await browser.smoke()
              state = {
                ...state,
                lastBrowserSmokeResultPath: await persistImmutableJsonArtifact(
                  state,
                  `checks/${cycle.id}-smoke.json`,
                  cycle.smoke
                ),
              }
              if (state.lastBrowserSmokeResultPath)
                cycle.artifacts.push(state.lastBrowserSmokeResultPath)
            } catch (error) {
              cycle.problems.push(`Browser scope: ${errorText(error)}`)
            }
          }
          for (const obligation of plan.obligations.filter(
            (o) => o.method !== 'agent_browser'
          )) {
            try {
              operation.remainingMs()
              let result: AcceptanceEvidence
              if (obligation.method === 'human_only')
                result = {
                  obligationId: obligation.id,
                  criterionId: obligation.criterionId,
                  expected: obligation.expected,
                  actual: obligation.reason ?? 'Human confirmation required.',
                  outcome: 'inconclusive',
                  gap: 'human_only',
                  method: obligation.method,
                  artifacts: [],
                  attempt: cycle.attempt,
                  identity,
                }
              else if (obligation.steps && browser)
                result = await browser.scenario(obligation, obligation.steps)
              else if (obligation.command)
                result = await retry(() =>
                  verifyCommand(
                    obligation,
                    state.repositoryRoot,
                    root,
                    identity,
                    cycle.attempt,
                    operation,
                    dependencies.maxOutputBytes
                  )
                )
              else
                result = {
                  obligationId: obligation.id,
                  criterionId: obligation.criterionId,
                  expected: obligation.expected,
                  actual: obligation.steps
                    ? 'Browser scope unavailable.'
                    : 'No executable static check.',
                  outcome: 'inconclusive',
                  gap: obligation.steps ? 'blocked' : 'inconclusive',
                  method: obligation.method,
                  artifacts: [],
                  attempt: cycle.attempt,
                  identity,
                }
              cycle.evidence.push(result)
            } catch (error) {
              const reason = errorText(error)
              cycle.problems.push(`${obligation.id}: ${reason}`)
              cycle.evidence.push({
                obligationId: obligation.id,
                criterionId: obligation.criterionId,
                expected: obligation.expected,
                actual: reason,
                outcome: 'inconclusive',
                gap:
                  signal.aborted || store.remaining(record) <= 0
                    ? 'not_attempted'
                    : 'blocked',
                method: obligation.method,
                artifacts: [],
                attempt: cycle.attempt,
                identity,
              })
            }
            await store.write(record)
          }
          if (plan.obligations.some((o) => o.method === 'agent_browser')) {
            if (browser) {
              const scope = browser
              const probes: NonNullable<VerificationCycle['probes']> = []
              cycle.probes = probes
              let errors: string[] = []
              try {
                await retry(async () => {
                  const invocationId = randomUUID()
                  const bridge = await openBrowserBridge(scope, plan, {
                    invocationId, probes, limits: dependencies.browserProbeLimits,
                  })
                  // A new invocation must establish its own conclusions; never reuse
                  // a prior pass when a later probe fails or remains inconclusive.
                  cycle.evidence = cycle.evidence.filter(e => e.method !== 'agent_browser')
                  try {
                    await dependencies.explore(state, plan, { ...operation, bridge: { ...bridge, invocationId } }, errors)
                    const validated = await validateAcceptanceEvidence(
                      bridge.evidence,
                      { ...plan, obligations: plan.obligations.filter(o => o.method === 'agent_browser') },
                      identity, cycle.attempt, root
                    )
                    errors = validated.problems
                    if (errors.length) throw new Error(`Invalid verifier evidence: ${errors.join(' ')}`)
                  } finally {
                    for (const evidence of bridge.evidence) {
                      cycle.evidence = cycle.evidence.filter(e => e.obligationId !== evidence.obligationId)
                      cycle.evidence.push(evidence)
                    }
                    cycle.artifacts.push(...probes.flatMap(p => [p.artifact, ...p.images.map(i => i.path), ...(p.trace ? [p.trace] : [])]))
                    cycle.artifacts.push(...bridge.evidence.flatMap(e => e.artifacts))
                    await bridge.close()
                    await store.write(record)
                  }
                })
              } catch (error) {
                cycle.problems.push(`Verifier exploration: ${errorText(error)}`)
              }
            } else {
              const actual =
                cycle.problems
                  .filter((p) => p.startsWith('Browser scope:'))
                  .join(' ') || 'Runtime browser scope unavailable.'
              cycle.problems.push(`Agent browser scenarios blocked: ${actual}`)
              cycle.evidence.push(
                ...plan.obligations
                  .filter((o) => o.method === 'agent_browser')
                  .map((o) => ({
                    obligationId: o.id,
                    criterionId: o.criterionId,
                    expected: o.expected,
                    actual,
                    outcome: 'inconclusive' as const,
                    gap: 'blocked' as const,
                    method: o.method,
                    artifacts: [],
                    attempt: cycle.attempt,
                    identity,
                  }))
              )
            }
          }
        } finally {
          await browser?.close()
        }
        const validated = await validateAcceptanceEvidence(
          cycle.evidence,
          plan,
          identity,
          cycle.attempt,
          root
        )
        cycle.evidence = validated.evidence
        cycle.problems.push(...validated.problems)
        cycle.artifacts.push(
          ...cycle.evidence.flatMap((e) => [
            ...e.artifacts,
            ...(e.attachments ?? []),
          ])
        )
        await store.write(record)
        try {
          operation.remainingMs()
          const reviewed = await retry(() =>
            dependencies.review(state, cycle, operation)
          )
          state = reviewed.state
          cycle.review = reviewed.result
          if (state.lastReviewResultPath)
            cycle.artifacts.push(state.lastReviewResultPath)
        } catch (error) {
          cycle.problems.push(`Semantic review: ${errorText(error)}`)
        }
      } finally {
        cycle.state = state
        await store.write(record)
      }
      const actionable =
        cycle.evidence.some((e) => e.outcome === 'fail') ||
        [cycle.fast, cycle.full].some((s) =>
          s?.checks.some(
            (c) => c.required && !c.passed && ![124, 127].includes(c.exitCode)
          )
        ) ||
        cycle.smoke?.findings.some((f) => f.category !== 'infrastructure') ||
        cycle.review?.findings.some((f) => f.severity !== 'suggestion')
      if (
        !actionable ||
        hasDismissedFindings ||
        !repairAfterInterruptionGranted ||
        signal.aborted ||
        store.remaining(record) <= 0 ||
        record.invocations.filter((i) => i.kind === 'repair').length >=
          record.repairsLimit
      )
        break
      const id = await store.charge(
        record,
        'repair',
        JSON.stringify(summarizeVerificationCycle(cycle))
      )
      const charged = record.invocations.find((i) => i.id === id)
      if (!charged) throw new Error('Charged repair invocation disappeared.')
      state = await dependencies.repair(state, charged.reason, operation)
      record.state = state
      charged.completed = true
      await store.write(record)
    }
  } catch (error) {
    const cycle = record.cycles.at(-1)
    if (cycle) cycle.problems.push(errorText(error))
    else
      record.cycles.push({
        id: randomUUID(),
        identity,
        attempt: 1,
        evidence: [],
        problems: [errorText(error)],
        artifacts: [],
        state,
      })
  } finally {
    dependencies.timer.clearTimeout(timer)
  }
  // Cleanup and local report construction may finish after the allowance. No agent work here.
  return finalizeReviewReport(state, record, identity, store)
}
