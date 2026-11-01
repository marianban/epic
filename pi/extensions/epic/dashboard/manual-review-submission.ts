import { currentManualReview } from '../manual-review.ts'
import { hasLikelyFailure } from '../evidence-outcome.ts'
import { canApproveTask, canRepairTask } from '../task-review-policy.ts'
import type { TaskVerificationRecord } from '../verification-types.ts'

export function manualReviewSubmission(record: TaskVerificationRecord): {
  kind: 'approve' | 'grant' | 'incomplete'
  label: string
} {
  if (!record.report) throw new Error('No human-review report is available.')
  const review = currentManualReview(record)
  if (canRepairTask(record.report.readiness, review.items.some((item) => item.status === 'failed'))) {
    return { kind: 'grant', label: 'Continue (request fixes)' }
  }
  if (!canApproveTask(record)) {
    if (hasLikelyFailure(record.report))
      return { kind: 'incomplete', label: 'Continue (resolve likely failure)' }
    return { kind: 'incomplete', label: 'Continue (complete manual review)' }
  }
  return { kind: 'approve', label: 'Continue (approve task)' }
}
