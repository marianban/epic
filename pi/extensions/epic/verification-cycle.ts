import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { EpicDomainState } from './types.ts'
import type {
  AcceptanceEvidence,
  VerificationCycle,
  VerificationOperation,
  TaskVerificationRecord,
} from './verification-types.ts'
import type { VerificationDependencies } from './verification-runner.ts'
import type { VerificationStore } from './verification-store.ts'
import { validateAcceptanceEvidence } from './acceptance-validation.ts'
import { BrowserExecution } from './browser-execution.ts'
import { openBrowserBridge } from './browser-bridge.ts'
import { verifyCommand } from './verification-command.ts'
import { persistImmutableJsonArtifact } from './persistence.ts'
import { hasBlockedPrerequisites } from './verification-schedule.ts'
import { obligationProblems } from './verification-problems.ts'

export async function executeVerificationCycle(
  initial: EpicDomainState,
  cycle: VerificationCycle,
  record: TaskVerificationRecord,
  store: VerificationStore,
  dependencies: VerificationDependencies,
  operation: VerificationOperation,
  retry: <T>(work: () => Promise<T>) => Promise<T>
): Promise<EpicDomainState> {
  let state = initial
  const { identity, plan } = cycle
  if (!plan) throw new Error('Verification cycle requires an explicit plan.')
  const root = path.dirname(store.file)
  const { signal } = operation
  const errorText = (error: unknown) =>
    error instanceof Error ? error.message : String(error)
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
        cycle.problems.push({
          stage: suite,
          obligationIds: [],
          message: `${suite}: ${errorText(error)}`,
        })
      }
      await store.write(record)
      // Repair a failed stage before spending allowance on later stages.
      // A failed prerequisite gates acceptance execution.
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
          cycle.browserOpened = true
          cycle.smoke = await browser.smoke()
          if (!cycle.smoke.passed)
            cycle.problems.push({
              stage: 'browser_smoke',
              obligationIds: [],
              message: `Browser smoke: ${cycle.smoke.findings.map((f) => f.message).join('; ')}`,
            })
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
          cycle.problems.push({
            stage: cycle.browserOpened ? 'browser_smoke' : 'browser_setup',
            obligationIds: [],
            message: `Browser scope: ${errorText(error)}`,
          })
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
          cycle.problems.push({
            stage: 'obligation',
            obligationIds: [obligation.id],
            message: `${obligation.id}: ${reason}`,
          })
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
                invocationId,
                probes,
                limits: dependencies.browserProbeLimits,
              })
              // A new invocation must establish its own conclusions; never reuse
              // a prior pass when a later probe fails or remains inconclusive.
              cycle.evidence = cycle.evidence.filter(
                (e) => e.method !== 'agent_browser'
              )
              try {
                await dependencies.explore(
                  state,
                  plan,
                  { ...operation, bridge: { ...bridge, invocationId } },
                  errors
                )
                const validated = await validateAcceptanceEvidence(
                  bridge.evidence,
                  {
                    ...plan,
                    obligations: plan.obligations.filter(
                      (o) => o.method === 'agent_browser'
                    ),
                  },
                  identity,
                  cycle.attempt,
                  root
                )
                errors = validated.problems
                if (errors.length)
                  throw new Error(
                    `Invalid verifier evidence: ${errors.join(' ')}`
                  )
              } finally {
                for (const evidence of bridge.evidence) {
                  cycle.evidence = cycle.evidence.filter(
                    (e) => e.obligationId !== evidence.obligationId
                  )
                  cycle.evidence.push(evidence)
                }
                cycle.artifacts.push(
                  ...probes.flatMap((p) => [
                    p.artifact,
                    ...p.images.map((i) => i.path),
                    ...(p.trace ? [p.trace] : []),
                  ])
                )
                cycle.artifacts.push(
                  ...bridge.evidence.flatMap((e) => e.artifacts)
                )
                await bridge.close()
                await store.write(record)
              }
            })
          } catch (error) {
            cycle.problems.push({
              stage: 'browser_exploration',
              obligationIds: plan.obligations
                .filter((o) => o.method === 'agent_browser')
                .map((o) => o.id),
              message: `Verifier exploration: ${errorText(error)}`,
            })
          }
        } else {
          const actual =
            cycle.problems
              .filter(
                (p) =>
                  p.stage === 'browser_setup' || p.stage === 'browser_smoke'
              )
              .map((p) => p.message)
              .join(' ') || 'Runtime browser scope unavailable.'
          cycle.problems.push({
            stage: 'browser_exploration',
            obligationIds: plan.obligations
              .filter((o) => o.method === 'agent_browser')
              .map((o) => o.id),
            message: `Agent browser scenarios blocked: ${actual}`,
          })
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
    cycle.problems.push(...obligationProblems(validated.problems, plan))
    cycle.artifacts.push(
      ...cycle.evidence.flatMap((e) => [
        ...e.artifacts,
        ...(e.attachments ?? []),
      ])
    )
    await store.write(record)
    if (
      cycle.kind === 'targeted' &&
      cycle.target?.kind === 'criterion' &&
      cycle.evidence.some((e) => e.method === 'agent_browser' && e.conclusion)
    ) {
      const obligationIds = cycle.evidence
        .filter((e) => e.method === 'agent_browser' && e.conclusion)
        .map((e) => e.obligationId)
      try {
        const reviewed = await retry(() =>
          dependencies.reviewEvidence(state, cycle, operation)
        )
        state = reviewed.state
        cycle.evidenceReviews.push({
          identity,
          obligationIds: reviewed.inspectedObligationIds,
          result: reviewed.result,
          limitations: reviewed.limitations,
        })
        const missing = obligationIds.filter(
          (id) => !reviewed.inspectedObligationIds.includes(id)
        )
        if (missing.length || reviewed.limitations.length)
          cycle.problems.push({
            stage: 'evidence_review',
            obligationIds: missing.length ? missing : obligationIds,
            message: `Browser evidence review incomplete: ${reviewed.limitations.join('; ') || `uninspected obligations ${missing.join(', ')}`}`,
          })
        if (state.lastReviewResultPath)
          cycle.artifacts.push(state.lastReviewResultPath)
      } catch (error) {
        cycle.problems.push({
          stage: 'evidence_review',
          obligationIds,
          message: `Browser evidence review: ${errorText(error)}`,
        })
      }
    }
    if (cycle.kind !== 'targeted' || cycle.target?.kind === 'semantic')
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
        cycle.problems.push({
          stage: 'semantic_review',
          obligationIds: [],
          message: `Semantic review: ${errorText(error)}`,
        })
      }
  } finally {
    cycle.state = state
    await store.write(record)
  }
  cycle.completed =
    !hasBlockedPrerequisites(cycle) &&
    !signal.aborted &&
    store.remaining(record) > 0
  await store.write(record)
  return state
}
