import type { HumanReviewReport, TaskDecisionRequest } from './verification-types.ts'
import { assertTaskRepairAvailable } from './task-review-policy.ts'

export function latestTaskRepairRequest(
  report: Pick<HumanReviewReport, 'identity' | 'id' | 'readiness'> | undefined,
  allowance: { repairs: number; timeMs: number },
  manualFailures: boolean
): Extract<TaskDecisionRequest, { kind: 'grant' }> {
  if (!report) throw new Error('No human-review report is available. Verify the current task first.')
  assertTaskRepairAvailable(report.readiness, manualFailures)
  return {
    kind: 'grant',
    identity: report.identity,
    reportId: report.id,
    repairs: allowance.repairs,
    timeMs: allowance.timeMs,
    reason: 'Repair unresolved issues in the latest task report.',
  }
}
