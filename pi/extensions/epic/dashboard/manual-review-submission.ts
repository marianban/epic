import { canRepairReviewedTask, reviewFailures } from '../failure-review.ts'
import { currentManualReview } from '../manual-review.ts'
import { canApproveTask } from '../task-review-policy.ts'
import { hasPendingFinalVerification } from '../final-verification-status.ts'
import type { TaskVerificationRecord } from '../verification-types.ts'

export function manualReviewSubmission(record: TaskVerificationRecord): {
  kind: 'approve' | 'grant' | 'verify' | 'incomplete'
  label: string
} {
  if (!record.report) throw new Error('No human-review report is available.')
  const review = currentManualReview(record)
  if (record.report.usage.remainingMs <= 0 && record.schedule.phase !== 'done' &&
      !review.items.some((item) => item.status === 'failed'))
    return { kind: 'verify', label: 'Continue (+15 minutes)' }
  if (canRepairReviewedTask(record) || review.items.some((item) => item.status === 'failed')) {
    return { kind: 'grant', label: 'Continue (request fixes)' }
  }
  if (hasPendingFinalVerification(record))
    return { kind: 'verify', label: 'Continue (+15 minutes)' }
  if (!canApproveTask(record)) {
    if (reviewFailures(record).length)
      return { kind: 'incomplete', label: 'Continue (complete failure review)' }
    return { kind: 'incomplete', label: 'Continue (complete manual review)' }
  }
  return { kind: 'approve', label: 'Continue (approve task)' }
}
