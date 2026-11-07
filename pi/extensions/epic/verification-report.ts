import { reportVerificationCycle } from './verification-report-cycle.ts'
import { createManualReview } from './manual-review.ts'
import { canRepairTask } from './task-review-policy.ts'
import { hasLikelyFailure } from './evidence-outcome.ts'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { EpicDomainState } from './types.ts'
import type {
  AcceptanceEvidence,
  TaskVerificationRecord,
  HumanReviewReport,
} from './verification-types.ts'
import { persistImmutableJsonArtifact, appendEvent } from './persistence.ts'
import type { VerificationStore } from './verification-store.ts'

export function constructReviewReport(
  record: TaskVerificationRecord,
  identity: string,
  remainingMs: number
): HumanReviewReport {
  const cycle = reportVerificationCycle(record, identity)
  const criteria = record.criteria.map((criterion) => {
    const obligations =
      record.plan?.obligations.filter((o) => o.criterionId === criterion.id) ??
      []
    const evidence = obligations.map((obligation) => {
      const confirmation = record.decisions.find(
        (d) =>
          d.kind === 'confirm' &&
          d.identity === identity &&
          d.obligations.includes(obligation.id)
      )
      const observed = cycle?.evidence.find(
        (e) => e.obligationId === obligation.id
      )
      if (confirmation && obligation.method === 'human_only')
        return {
          obligationId: obligation.id,
          criterionId: criterion.id,
          expected: obligation.expected,
          actual: confirmation.reason,
          outcome: 'pass',
          method: 'human_only',
          artifacts: [],
          attempt: cycle?.attempt ?? 0,
          identity,
        } satisfies AcceptanceEvidence
      return (
        observed ??
        ({
          obligationId: obligation.id,
          criterionId: criterion.id,
          expected: obligation.expected,
          actual: obligation.reason ?? 'No current validated evidence.',
          outcome: 'inconclusive',
          gap:
            obligation.method === 'human_only' ? 'human_only' : 'not_attempted',
          method: obligation.method,
          artifacts: [],
          attempt: cycle?.attempt ?? 0,
          identity,
        } satisfies AcceptanceEvidence)
      )
    })
    const status = evidence.some((e) => e.outcome === 'fail' || e.outcome === 'likely-fail')
      ? 'not_met'
      : evidence.length && evidence.every((e) => e.outcome === 'pass')
        ? 'met'
        : evidence.some((e) => e.outcome === 'pass')
          ? 'partially_met'
          : 'manual_review_pending'
    return {
      ...criterion,
      status,
      evidence,
    } as HumanReviewReport['criteria'][number]
  })
  const unresolved = criteria.flatMap((c) =>
    c.evidence.filter((e) => e.outcome !== 'pass').map((e) => e.obligationId)
  )
  for (const criterion of criteria)
    if (!criterion.evidence.length) unresolved.push(criterion.id)
  const task = cycle?.state.tasks?.[cycle.state.currentTaskIndex]
  const checks = [
    ...(cycle?.fast?.checks ?? []),
    ...(cycle?.full?.checks ?? []),
  ]
  const reviewFindings = [
    ...(cycle?.review?.findings ?? []),
    ...(cycle?.evidenceReviews.flatMap(r => r.result.findings) ?? []),
  ]
  const mandatoryMissing =
    !cycle?.fast ||
    !cycle.full ||
    !cycle.review ||
    (task?.requiredChecks.includes('browser-smoke') && !cycle.smoke?.passed)
  for (const name of task?.requiredChecks ?? []) {
    if (
      name === 'browser-smoke'
        ? !cycle?.smoke?.passed
        : !checks.some((c) => c.name === name && c.passed && !c.skipped)
    )
      unresolved.push(`check:${name}`)
  }
  if (!cycle?.fast) unresolved.push('check:fast')
  if (!cycle?.full) unresolved.push('check:full')
  if (!cycle?.review) unresolved.push('review:semantic')
  if (cycle && !cycle.completed) unresolved.push('verification:incomplete')
  if (cycle?.smoke && !cycle.smoke.passed)
    unresolved.push('check:browser-smoke')
  for (const entry of cycle?.evidence ?? []) {
    if (entry.method !== 'agent_browser' || !entry.conclusion) continue
    const fullReview = record.cycles.some(c => c.kind !== 'targeted' && c.identity === entry.identity && c.review)
    const focusedReview = cycle?.evidenceReviews.some(r =>
      r.identity === entry.identity && r.obligationIds.includes(entry.obligationId) && !r.limitations.length)
    if (!fullReview && !focusedReview) unresolved.push(`review:evidence:${entry.obligationId}`)
  }
  const pendingRepair = record.schedule.queue.some(item => item.action === 'repair')
  const fullPending = record.schedule.finalRequired
  if (fullPending) unresolved.push('verification:final_full')
  const productFailure =
    pendingRepair ||
    criteria.some((c) => c.status === 'not_met') ||
    checks.some(
      (c) => c.required && !c.passed && ![124, 127].includes(c.exitCode)
    ) ||
    !!cycle?.smoke?.findings.some((f) => f.category !== 'infrastructure') ||
    reviewFindings.some((f) => f.severity !== 'suggestion')
  if (reviewFindings.some((f) => f.severity !== 'suggestion'))
    unresolved.push('review:findings')
  const problems = [...(cycle?.problems.map(p => p.message) ?? [
    'No current verification cycle.',
    ...(record.cycles.at(-1)?.problems.map(p => p.message) ?? []),
  ]), ...record.schedule.queue.map(item => `Pending ${item.action}: ${item.id}. ${item.feedback}`), ...(fullPending ? ['Final full verification remains incomplete.'] : [])]
  for (const [i] of problems.entries()) unresolved.push(`problem:${i + 1}`)
  if (cycle?.fast && !cycle.fast.passed) unresolved.push('check:fast')
  if (cycle?.full && !cycle.full.passed) unresolved.push('check:full')
  const readiness = productFailure
    ? 'issues_remaining'
    : unresolved.length ||
        mandatoryMissing ||
        problems.length ||
        criteria.some((c) => c.status !== 'met')
      ? 'needs_manual_confirmation'
      : 'verified'
  return {
    id: randomUUID(),
    taskId: record.taskId,
    identity,
    criterionVersion: record.criterionVersion,
    scenarioVersion: record.plan?.version,
    readiness,
    criteria,
    unresolved: [...new Set(unresolved)],
    problems,
    cycle,
    history: record.cycles,
    usage: {
      repairs: record.invocations.filter((i) => i.kind === 'repair').length,
      infrastructure: record.invocations.filter(
        (i) => i.kind === 'infrastructure'
      ).length,
      repairsLimit: record.repairsLimit,
      infrastructureLimit: record.infrastructureLimit,
      remainingMs,
      consumedMs: Math.max(0, record.timeAllowanceMs - remainingMs),
    },
    grants: record.grants,
    artifacts: cycle?.artifacts ?? [],
    invocations: record.invocations,
  }
}

export function reviewReportMarkdown(report: HumanReviewReport, reportPath: string): string {
  if (!path.isAbsolute(reportPath))
    throw new Error('Review report Markdown requires an absolute output path.')
  const artifactLink = (label: string, target: string): string => {
    const relative = path.relative(path.dirname(reportPath), target)
    const href = relative.split(path.sep).map(segment =>
      encodeURIComponent(segment).replace(/[!'()*]/g, char =>
        `%${char.charCodeAt(0).toString(16).toUpperCase()}`
      )
    ).join('/')
    return `[${label}](${href})`
  }
  return [
    `# Task ${report.taskId} human review`,
    '',
    `Readiness: **${report.readiness}**`,
    `Verification attempt: ${report.identity}`,
    `Cycle: ${report.cycle?.kind ?? 'not completed'}${report.cycle?.target ? `; target ${report.cycle.target.id}` : ''}`,
    `Report: ${report.id}`,
    '',
    '## Acceptance criteria',
    '',
    ...report.criteria.flatMap((c) => [
      `- **${c.id}: ${c.status}** — ${c.text}`,
      ...c.evidence.map(
        (e) =>
          `  - ${e.obligationId}: ${e.outcome}${e.gap ? ` (${e.gap})` : ''}. Expected: ${e.expected}. Observed: ${e.actual}${e.reproduction ? ` Reproduce: ${e.reproduction}` : ''}. ${e.artifacts.map((p) => artifactLink('evidence', p)).join(' ')}`
      ),
      ...c.evidence.flatMap((e) => e.suspectedFailure ? [
        `  - Suspected failure: ${e.suspectedFailure.contradiction}`,
        `  - Uncertainty: ${e.suspectedFailure.uncertainty}`,
        `  - Confirmation check: ${e.suspectedFailure.confirmationCheck}`,
      ] : []),
      ...c.evidence.flatMap(e => e.conclusion ? [
        `  - Conclusion ${e.conclusion.id} (${e.conclusion.basis}): ${e.conclusion.explanation}`,
        `  - Cited evidence: ${e.conclusion.evidenceIds.join(', ') || 'none'}. Limitations: ${e.conclusion.limitations.join('; ') || 'none'}.`,
        ...e.conclusion.observations.map(o => `  - Observation ${o.evidenceId}: ${o.target} (${o.targetIdentity}), ${o.property}: ${o.value}.`),
        `  - Self-check: alternative explanation: ${e.conclusion.selfCheck.alternativeExplanation}; counter-evidence: ${e.conclusion.selfCheck.counterEvidence}; would pass if broken: ${e.conclusion.selfCheck.wouldPassIfBroken}; ${e.conclusion.selfCheck.reasoning}`,
        ...(e.conclusion.temporalComparison ? [`  - Temporal comparison: ${e.conclusion.temporalComparison}`] : []),
        ...(e.conclusion.separateExecutions ? [`  - Separate executions: ${e.conclusion.separateExecutions}`] : []),
      ] : []),
    ]),
    '',
    '## Browser probes (each ran on a fresh page)',
    ...(report.cycle?.probes ?? []).flatMap(p => [
      `- ${artifactLink(`Probe ${p.id}`, p.artifact)}, obligation ${p.obligationId}, invocation ${p.invocationId}, ${p.startedAt}–${p.completedAt}.`,
      ...p.observations.map(o => `  - ${o.id} at ${o.timestamp}: ${o.kind}, ${JSON.stringify(o.value)}${o.passed === undefined ? '' : ` (assertion ${o.passed ? 'passed' : 'failed'})`}`),
      ...p.images.map(i => `  - ${artifactLink(`Image ${i.id}`, i.path)} at ${i.timestamp}, ${i.width}×${i.height}${i.selector ? `, crop ${i.selector}` : ''}.`),
      ...p.runtimeErrors.map(e => `  - Application/runtime error: ${e}`),
      ...p.probeErrors.map(e => `  - Probe error: ${e}`),
    ]),
    '',
    '## Checks and remaining issues',
    '',
    ...[report.cycle?.fast, report.cycle?.full].map((c) =>
      c
        ? `${c.suite}: ${c.passed ? 'passed' : 'failed'}\n${c.checks.map((k) => `- ${k.name}: ${k.skipped ? `skipped (${k.skipReason})` : k.passed ? 'passed' : 'failed'}\n${k.stderrPreview}`).join('\n')}`
        : 'Checks not attempted.'
    ),
    `Browser smoke: ${report.cycle?.smoke ? (report.cycle.smoke.passed ? 'passed' : `failed: ${report.cycle.smoke.findings.map((f) => f.message).join('; ')}`) : 'not attempted or blocked'}`,
    `Semantic review: ${report.cycle?.review ? report.cycle.review.summary : 'not attempted or blocked'}`,
    ...(report.cycle?.evidenceReviews.flatMap(r => [
      `Browser evidence review (${r.identity}; ${r.obligationIds.join(', ')}): ${r.result.summary}`,
      ...r.limitations.map(message => `- Evidence review limitation: ${message}`),
      ...r.result.findings.map(f => `- ${f.severity}: ${f.message}; fix: ${f.requiredFix}`),
    ]) ?? []),
    ...(report.cycle?.review?.findings.map(
      (f) =>
        `- ${f.severity}: ${f.message}; ${f.file ?? f.affectedPaths.join(', ')}; reproduce: ${f.failureScenario}; fix: ${f.requiredFix}`
    ) ?? []),
    ...report.problems.map((p) => `- ${p}`),
    '',
    '## Allowances',
    '',
    `Repairs: ${report.usage.repairs}/${report.usage.repairsLimit}. Infrastructure retries: ${report.usage.infrastructure}/${report.usage.infrastructureLimit}. Time consumed: ${report.usage.consumedMs}ms; remaining: ${report.usage.remainingMs}ms.`,
    ...report.grants.map(
      (g) => `- Grant: ${g.repairs} repairs, ${g.timeMs}ms: ${g.reason}`
    ),
    ...report.invocations.map(
      (i) =>
        `- ${i.kind} ${i.id}: ${i.completed ? 'completed' : 'interrupted or failed'}; ${i.reason}`
    ),
    '',
    '## Attempts and artifacts',
    '',
    ...report.history.map(
      (c) =>
        `- Cycle ${c.attempt}: ${c.kind}; ${c.target ? `target ${c.target.id}; ` : ''}${c.identity}; criteria version ${c.plan?.criterionVersion ?? 'unknown'}, scenario version ${c.plan?.version ?? 'unknown'}; ${c.invalidated ?? ''}; ${c.problems.map(p => p.message).join('; ')}; ${c.artifacts.map((p) => artifactLink('artifact', p)).join(' ')}`
    ),
    '',
    '## Human decisions',
    '',
    'Complete the checklist in the dashboard, then choose Continue. Failure Review Steps replace the manual checklist when findings are present: Pass confirms the behavior works, Fail requests a fix, and Ignored accepts the finding without a fix. Enter adds an optional observation. Approval requires every failure step to be Pass or Ignored, or every manual step to pass when no failures are listed. Recorded failed manual steps still block approval. The report retains its original findings and evidence; decisions are recorded separately in the verification ledger and dashboard review history.',
    ...(hasLikelyFailure(report)
      ? ['Observed contradictions, including likely failures, require repair and block approval. Use the recorded evidence to diagnose and fix the behavior; uncertainty about the cause does not require human confirmation before repair.']
      : []),
    ...(canRepairTask(report.readiness, false)
      ? ['Use /task-repair to grant one additional repair attempt and five additional minutes for the recorded failures.']
      : report.readiness === 'needs_manual_confirmation' && !hasLikelyFailure(report)
        ? ['Verification has unresolved evidence, with no actionable failure recorded. Review it manually.']
        : []),
    'If a manual check reveals incorrect behavior, mark it failed in the dashboard and record an observation to request fixes. To review later, use /epic-exit to hide the dashboard; the task remains awaiting review.',
    '',
  ].join('\n')
}

export async function finalizeReviewReport(
  state: EpicDomainState,
  record: TaskVerificationRecord,
  identity: string,
  store: VerificationStore
): Promise<EpicDomainState> {
  record.state = state
  await store.pause(record)
  const report = constructReviewReport(
    record,
    identity,
    store.remaining(record)
  )
  record.report = report
  record.manualReviews.push(createManualReview(state, report, store.clock.nowMs()))
  await store.write(record)
  const relative = path.join(
    'reviews',
    `task-${state.currentTaskIndex + 1}-${report.id}-acceptance.json`
  )
  const file = await persistImmutableJsonArtifact(state, relative, report)
  const markdownPath = file.replace(/\.json$/, '.md')
  await fs.writeFile(
    markdownPath,
    reviewReportMarkdown(report, markdownPath),
    { flag: 'wx' }
  )
  await appendEvent(
    state,
    'finalizing_report',
    store.clock.now(),
    'task_review_completed',
    {
      taskId: record.taskId,
      criteriaCompleted: report.criteria.filter((c) => c.status === 'met')
        .length,
      criteriaTotal: report.criteria.length,
      readiness: report.readiness,
      reportId: report.id,
      identity,
      reportPath: file,
    }
  )
  return {
    ...state,
    lastVerificationReportPath: file,
    verificationReadiness: report.readiness,
    taskRevalidationRequired: false,
  }
}
