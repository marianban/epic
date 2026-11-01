import { canRepairReviewedTask, reviewFailures, isFailureDismissed } from '../failure-review.ts'
import { currentManualReview } from '../manual-review.ts'
import { canApproveTask } from '../task-review-policy.ts'
import type { TaskVerificationRecord } from '../verification-types.ts'

export function manualReviewSubmission(record: TaskVerificationRecord): {
  kind: 'approve' | 'grant' | 'incomplete'
  label: string
} {
  if (!record.report) throw new Error('No human-review report is available.')
  const review = currentManualReview(record)
  if (canRepairReviewedTask(record) || review.items.some((item) => item.status === 'failed')) {
    return { kind: 'grant', label: 'Continue (request fixes)' }
  }
  if (!canApproveTask(record)) {
    if (reviewFailures(record).some(f => f.likely && !isFailureDismissed(f)))
      return { kind: 'incomplete', label: 'Continue (resolve likely failure)' }
    return { kind: 'incomplete', label: 'Continue (complete manual review)' }
  }
  return { kind: 'approve', label: 'Continue (approve task)' }
}
