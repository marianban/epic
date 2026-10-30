import { currentManualReview, unresolvedReviewIds } from '../manual-review.ts'
import type { TaskVerificationRecord } from '../verification-types.ts'

export function manualReviewSubmission(record: TaskVerificationRecord): {
  kind: 'approve' | 'grant' | 'accept_unresolved'
  label: string
} {
  if (!record.report) throw new Error('No human-review report is available.')
  const review = currentManualReview(record)
  if (review.items.some((item) => item.status === 'failed')) {
    return { kind: 'grant', label: 'Continue (request fixes)' }
  }
  if (record.report.readiness !== 'verified' || unresolvedReviewIds(record).length > 0) {
    return { kind: 'accept_unresolved', label: 'Continue (accept limitations)' }
  }
  return { kind: 'approve', label: 'Continue (approve task)' }
}
