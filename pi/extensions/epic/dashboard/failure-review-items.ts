import { reviewFailures } from '../failure-review.ts'
import type { TaskVerificationRecord } from '../verification-types.ts'
import type { FailureReviewItem, FailureReviewStatus } from './types.ts'

export const failureReviewReasons: Record<Exclude<FailureReviewStatus, 'not_checked'>, string> = {
  passed: 'Human marked this step Pass; accept without a fix.',
  failed: 'Human marked this step Fail; request a fix.',
}

export function failureReviewItems(record: TaskVerificationRecord): FailureReviewItem[] {
  return reviewFailures(record).map(f => ({
    id: f.id,
    text: f.expected,
    status: f.decision?.kind === 'false_positive' || f.decision?.kind === 'accepted_noncritical' ? 'passed'
      : f.decision?.kind === 'request_fix' ? 'failed' : 'not_checked',
    observation: Object.values(failureReviewReasons).includes(f.decision?.reason ?? '') ? '' : f.decision?.reason ?? '',
  }))
}
