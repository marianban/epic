import { currentManualReview } from './manual-review.ts'
import { reviewFailures, isFailureDismissed } from './failure-review.ts'
import type { HumanReviewReport, TaskVerificationRecord } from './verification-types.ts'

export function canApproveTask(record: TaskVerificationRecord): boolean {
  const report = record.report
  if (!report) throw new Error('No human-review report is available.')
  const failures = reviewFailures(record)
  if (failures.some(f => !isFailureDismissed(f) && (f.likely || report.readiness === 'issues_remaining' || f.decision?.kind === 'request_fix'))) return false
  const items = currentManualReview(record).items
  if (items.some((item) => item.status !== 'passed')) return false
  return (report.readiness === 'issues_remaining' && failures.length > 0 && failures.every(isFailureDismissed)) || report.readiness === 'verified' ||
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
