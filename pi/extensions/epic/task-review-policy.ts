import { currentManualReview } from './manual-review.ts'
import { hasLikelyFailure } from './evidence-outcome.ts'
import type { HumanReviewReport, TaskVerificationRecord } from './verification-types.ts'

export function canApproveTask(record: TaskVerificationRecord): boolean {
  const report = record.report
  if (!report) throw new Error('No human-review report is available.')
  if (hasLikelyFailure(report)) return false
  const items = currentManualReview(record).items
  if (items.some((item) => item.status !== 'passed')) return false
  return report.readiness === 'verified' ||
    (report.readiness === 'needs_manual_confirmation' && items.length > 0)
}

/** Missing evidence is not a defect that an implementation repair can address. */
export function canRepairTask(
  readiness: HumanReviewReport['readiness'] | undefined,
  manualFailures: boolean
): boolean {
  return manualFailures || readiness === 'issues_remaining'
}

export function assertTaskRepairAvailable(
  readiness: HumanReviewReport['readiness'],
  manualFailures: boolean
): void {
  if (canRepairTask(readiness, manualFailures)) return
  if (readiness === 'verified')
    throw new Error('The current task is already verified; no repair is needed.')
  throw new Error(
    'No actionable failure is recorded. Review the unresolved evidence manually.'
  )
}
