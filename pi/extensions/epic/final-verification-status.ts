import type { TaskVerificationRecord } from './verification-types.ts'

export function hasPendingFinalVerification(record: TaskVerificationRecord): boolean {
  return record.schedule.finalRequired
}

export function finalVerificationStatus(record: TaskVerificationRecord): string | undefined {
  if (!hasPendingFinalVerification(record)) return undefined
  const report = record.report
  const interruption = report?.cycle?.problems.find(p => p.stage === 'interruption')
  const reason = report && report.usage.remainingMs <= 0
    ? 'The task verification time allowance was exhausted.'
    : interruption?.message ?? report?.cycle?.problems.at(-1)?.message
      ?? 'Verification stopped before the required final pass completed.'
  return `Final verification pending. ${reason} Continue resumes verification; approval requires the final pass to finish.`
}
