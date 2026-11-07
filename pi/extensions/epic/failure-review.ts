import type { FailureDisposition, HumanDecision, TaskVerificationRecord } from './verification-types.ts'

export const failureDispositionLabels: Record<FailureDisposition, string> = {
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
  // Missing evidence alone is not a failure and must not create a failure section.
  const unresolvedFailures = report.readiness === 'issues_remaining' || failures.size > 0
    ? report.unresolved : []
  // These IDs also represent failed checks, semantic findings and verifier errors.
  for (const id of unresolvedFailures) {
    if (failures.has(id) || (!id.startsWith('check:') && !id.startsWith('review:') && !id.startsWith('problem:'))) continue
    const check = [...(report.cycle?.fast?.checks ?? []), ...(report.cycle?.full?.checks ?? [])].find(c => `check:${c.name}` === id)
    failures.set(id, {
      id, expected: id,
      actual: id.startsWith('problem:') ? report.problems[Number(id.slice(8)) - 1] ?? id
        : check ? check.stderrPreview || check.stdoutPreview || 'Check did not pass.'
        : id === 'review:findings' ? [...(report.cycle?.review?.findings ?? []), ...(report.cycle?.evidenceReviews.flatMap(r => r.result.findings) ?? [])].map(f => f.message).join('\n') || id
        : id === 'check:browser-smoke' ? report.cycle?.smoke?.findings.map(f => f.message).join('\n') ?? id
        : id === 'check:fast' || id === 'check:full' ? 'Check suite did not pass or was not completed.' : 'Verification did not complete.',
      likely: false,
    })
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

export function canRepairReviewedTask(record: TaskVerificationRecord): boolean {
  const report = record.report
  if (!report) throw new Error('No human-review report is available.')
  return reviewFailures(record).some(f => !isFailureDismissed(f) && ((!f.likely && report.readiness === 'issues_remaining') || f.decision?.kind === 'request_fix')) ||
    (report.readiness === 'issues_remaining' && reviewFailures(record).length === 0)
}

export function failureRepairFeedback(record: TaskVerificationRecord): string {
  const instructions = reviewFailures(record).map(f =>
    `${f.id}: ${f.expected}\nObserved: ${f.actual}\nHuman decision: ${f.decision ? failureDispositionLabels[f.decision.kind as FailureDisposition] : f.likely ? 'Unconfirmed suspicion; investigate before changing code.' : 'Unresolved issue'}${f.decision ? `\nReason: ${f.decision.reason}` : ''}`
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
