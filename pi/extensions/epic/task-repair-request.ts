import type { HumanReviewReport, TaskDecisionRequest } from './verification-types.ts'

export function latestTaskRepairRequest(
  report: Pick<HumanReviewReport, 'identity' | 'id' | 'readiness'> | undefined,
  allowance: { repairs: number; timeMs: number },
  manualFailures: boolean
): Extract<TaskDecisionRequest, { kind: 'grant' }> {
  if (!report) throw new Error('No human-review report is available. Verify the current task first.')
  if (report.readiness === 'verified' && !manualFailures)
    throw new Error('The current task is already verified; no repair is needed.')
  return {
    kind: 'grant',
    identity: report.identity,
    reportId: report.id,
    repairs: allowance.repairs,
    timeMs: allowance.timeMs,
    reason: 'Repair unresolved issues in the latest task report.',
  }
}
