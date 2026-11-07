import { reviewFailures } from '../failure-review.ts'
import type { TaskVerificationRecord } from '../verification-types.ts'
import type { FailureReviewItem, FailureReviewStatus } from './types.ts'

export const failureReviewReasons: Record<Exclude<FailureReviewStatus, 'not_checked'>, string> = {
  passed: 'Human marked this step Pass.',
  failed: 'Human marked this step Fail; request a fix.',
  ignored: 'Human marked this step Ignored; accept without a fix.',
}

export function failureReviewItems(record: TaskVerificationRecord): FailureReviewItem[] {
  return reviewFailures(record).map(f => ({
    id: f.id,
    text: f.expected,
    status: f.decision?.kind === 'false_positive' ? 'passed'
      : f.decision?.kind === 'request_fix' ? 'failed'
      : f.decision?.kind === 'accepted_noncritical' ? 'ignored' : 'not_checked',
    observation: Object.values(failureReviewReasons).includes(f.decision?.reason ?? '') ? '' : f.decision?.reason ?? '',
  }))
}
