import type { EvidenceOutcome, SuspectedFailure, HumanReviewReport } from './verification-types.ts'

export function assertSuspectedFailure(
  outcome: EvidenceOutcome,
  value: SuspectedFailure | undefined
): void {
  if (outcome !== 'likely-fail') {
    if (value !== undefined)
      throw new Error('Only likely-fail evidence may include suspectedFailure.')
    return
  }
  if (
    !value ||
    [value.contradiction, value.uncertainty, value.confirmationCheck].some(
      (field) => typeof field !== 'string' || !field.trim()
    )
  )
    throw new Error('Likely-fail requires suspectedFailure with contradiction, uncertainty, and confirmationCheck.')
}

export function hasLikelyFailure(report: HumanReviewReport): boolean {
  return report.criteria.some((criterion) =>
    criterion.evidence.some((evidence) => evidence.outcome === 'likely-fail')
  )
}
