import { reviewFailures } from '../failure-review.ts'
import type { FailureDisposition, TaskDecisionRequest, TaskVerificationRecord } from '../verification-types.ts'
import type { FailureReviewStatus } from './types.ts'
import { failureReviewItems, failureReviewReasons } from './failure-review-items.ts'

export async function editFailureReview(
  record: TaskVerificationRecord,
  itemId: string | undefined,
  targetStatus: FailureReviewStatus | undefined,
  editor: (title: string, value: string) => Promise<string | undefined>
): Promise<Extract<TaskDecisionRequest, { kind: 'review_failure' }> | undefined> {
  const report = record.report
  if (!report) throw new Error('No human-review report is available.')
  const failure = reviewFailures(record).find(f => f.id === itemId)
  const item = failureReviewItems(record).find(f => f.id === itemId)
  if (!failure || !item) throw new Error('Unknown failure review step.')
  const status = targetStatus ?? item.status
  if (status === 'not_checked') {
    if (!targetStatus) throw new Error('Mark the step Pass or Fail before adding an observation.')
    return { kind: 'review_failure', identity: report.identity, reportId: report.id,
      failureId: failure.id, disposition: 'not_checked', reason: 'Human reset this step to Unchecked.' }
  }
  const dispositions: Record<Exclude<FailureReviewStatus, 'not_checked'>, FailureDisposition> = {
    passed: 'accepted_noncritical', failed: 'request_fix',
  }
  let reason = targetStatus ? failureReviewReasons[status] : item.observation
  if (!targetStatus) {
    const edited = await editor(`${item.text} — Observation`, reason)
    if (edited === undefined) return
    reason = edited
  }
  if (!reason.trim()) throw new Error('A failure decision requires an explicit reason.')
  return { kind: 'review_failure', identity: report.identity, reportId: report.id,
    failureId: failure.id, disposition: dispositions[status], reason }
}
