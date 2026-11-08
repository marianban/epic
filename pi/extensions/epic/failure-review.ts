import type { FailureDisposition, HumanDecision, TaskVerificationRecord } from './verification-types.ts'

const failureDispositionLabels: Record<FailureDisposition, string> = {
  request_fix: 'Real issue — request fix',
  false_positive: 'False positive — skip fix',
  accepted_noncritical: 'Noncritical — accept without fix',
}

export interface ReviewFailure {
  id: string
  expected: string
  actual: string
  likely: boolean
  decision?: HumanDecision
}

/** Original findings remain immutable. Decisions apply only to the current report. */
export function reviewFailures(record: TaskVerificationRecord): ReviewFailure[] {
  const report = record.report
  if (!report) throw new Error('No human-review report is available.')
  const failures = new Map<string, ReviewFailure>()
  for (const criterion of report.criteria) {
    for (const evidence of criterion.evidence) {
      if (evidence.outcome === 'fail' || evidence.outcome === 'likely-fail')
        failures.set(evidence.obligationId, {
          id: evidence.obligationId, expected: evidence.expected,
          actual: evidence.actual, likely: evidence.outcome === 'likely-fail',
        })
    }
  }
  for (const entry of report.findings) {
    if (entry.status !== 'open' || entry.feedback.severity === 'suggestion') continue
    const f = entry.feedback
    failures.set(`review:${entry.id}`, {
      id: `review:${entry.id}`, expected: f.requiredFix,
      actual: `${f.message}\n${f.failureScenario}`, likely: false,
    })
  }
  // Missing evidence alone is not a failure and must not create a failure section.
  const unresolvedFailures = report.readiness === 'issues_remaining' || failures.size > 0
    ? report.unresolved : []
  // Only observed application/check failures belong in the checklist. Workflow
  // problems, missing checks and interrupted verification remain report status.
  for (const id of unresolvedFailures) {
    if (failures.has(id) || !id.startsWith('check:')) continue
    const check = [...(report.cycle?.fast?.checks ?? []), ...(report.cycle?.full?.checks ?? [])].find(c =>
      `check:${c.name}` === id && !c.passed && !c.skipped && ![124, 127].includes(c.exitCode))
    const suite = id === 'check:fast' ? report.cycle?.fast : id === 'check:full' ? report.cycle?.full : undefined
    const failedChecks = suite?.checks.filter(c => c.required && !c.passed && !c.skipped && ![124, 127].includes(c.exitCode)) ?? []
    const smoke = id === 'check:browser-smoke' ? report.cycle?.smoke : undefined
    if (!check &&
        !failedChecks.length && !smoke?.findings.some(f => f.category !== 'infrastructure')) continue
    failures.set(id, {
      id, expected: check ? `Check ${check.name} must pass.`
        : id === 'check:browser-smoke' ? 'Browser smoke checks must pass.'
        : id === 'check:fast' ? 'Fast checks must pass.' : 'Full checks must pass.',
      actual: check ? check.stderrPreview || check.stdoutPreview || 'Check did not pass.'
        : id === 'check:browser-smoke' ? report.cycle?.smoke?.findings.map(f => f.message).join('\n') ?? id
        : id === 'check:fast' || id === 'check:full' ? 'Check suite did not pass or was not completed.' : 'Review the verification report for the failed check.',
      likely: false,
    })
  }
  // Deduplicate only after individual failures have been collected, regardless of report order.
  for (const suite of [report.cycle?.fast, report.cycle?.full]) {
    const failedChecks = suite?.checks.filter(c => c.required && !c.passed && !c.skipped && ![124, 127].includes(c.exitCode)) ?? []
    if (suite && failedChecks.length && failedChecks.every(c => failures.has(`check:${c.name}`)))
      failures.delete(`check:${suite.suite}`)
  }
  for (const failure of failures.values()) {
    failure.decision = [...record.decisions].reverse().find(d =>
      d.reportId === report.id && d.identity === report.identity &&
      ['request_fix', 'false_positive', 'accepted_noncritical'].includes(d.kind) &&
      d.obligations.includes(failure.id))
  }
  return [...failures.values()]
}

export function isFailureDismissed(failure: ReviewFailure): boolean {
  return failure.decision?.kind === 'false_positive' || failure.decision?.kind === 'accepted_noncritical'
}

/** Human dispositions also apply to the scheduler's criterion and check identities. */
export function dismissedRepairItemIds(record: TaskVerificationRecord): Set<string> {
  const report = record.report
  if (!report) throw new Error('No human-review report is available.')
  const dismissed = reviewFailures(record).filter(isFailureDismissed)
  const ids = new Set(dismissed.map(f => f.id))
  for (const criterion of report.criteria) {
    if (criterion.evidence.some(e => ids.has(e.obligationId))) ids.add(criterion.id)
  }
  for (const suite of [report.cycle?.fast, report.cycle?.full]) {
    if (suite && ids.has(`check:${suite.suite}`)) {
      for (const check of suite.checks) {
        if (check.required && !check.passed) ids.add(`check:${check.name}`)
      }
    }
  }
  return ids
}

export function canRepairReviewedTask(record: TaskVerificationRecord): boolean {
  const report = record.report
  if (!report) throw new Error('No human-review report is available.')
  return reviewFailures(record).some(f => !isFailureDismissed(f) && (report.readiness === 'issues_remaining' || f.decision?.kind === 'request_fix'))
}

export function failureRepairFeedback(record: TaskVerificationRecord): string {
  const instructions = reviewFailures(record).map(f =>
    `${f.id}: ${f.expected}\nObserved: ${f.actual}\nHuman decision: ${f.decision ? failureDispositionLabels[f.decision.kind as FailureDisposition] : 'Unresolved issue; diagnose and fix the observed behavior.'}${f.decision ? `\nReason: ${f.decision.reason}` : ''}`
  ).join('\n\n')
  return instructions ? `Honor the human decisions below. Do not change implementation to satisfy findings marked skip fix or accept without fix.\n\n${instructions}` : ''
}

export function validateFailureDecisions(record: TaskVerificationRecord): void {
  for (const decision of record.decisions) {
    if (!['request_fix', 'false_positive', 'accepted_noncritical'].includes(decision.kind)) continue
    if (typeof decision.identity !== 'string' || !decision.identity ||
        typeof decision.reportId !== 'string' || !decision.reportId ||
        !Array.isArray(decision.obligations) || decision.obligations.length !== 1 ||
        typeof decision.obligations[0] !== 'string' || !decision.obligations[0] ||
        typeof decision.reason !== 'string' || !decision.reason.trim() || !Number.isFinite(decision.at))
      throw new Error('Invalid persisted failure review decision.')
  }
}
