import { failureDispositionLabels, reviewFailures } from '../failure-review.ts'
import type { FailureDisposition, TaskDecisionRequest, TaskVerificationRecord } from '../verification-types.ts'

export async function editFailureReview(
  record: TaskVerificationRecord,
  select: (title: string, options: string[]) => Promise<string | undefined>,
  editor: (title: string, value: string) => Promise<string | undefined>
): Promise<Extract<TaskDecisionRequest, { kind: 'review_failure' }> | undefined> {
  const report = record.report
  if (!report) throw new Error('No human-review report is available.')
  const failures = reviewFailures(record)
  const labels = failures.map(f => `${f.id}: ${f.expected} [${f.decision ? failureDispositionLabels[f.decision.kind as FailureDisposition] : 'Not reviewed'}]`)
  const selected = await select('Select a verification finding to review', labels)
  if (selected === undefined) return
  const failure = failures[labels.indexOf(selected)]
  if (!failure) throw new Error('Unknown verification finding.')
  const dispositions = Object.keys(failureDispositionLabels) as FailureDisposition[]
  const choice = await select(`${failure.expected}\nObserved: ${failure.actual}`, dispositions.map(d => failureDispositionLabels[d]))
  if (choice === undefined) return
  const disposition = dispositions.find(d => failureDispositionLabels[d] === choice)
  if (!disposition) throw new Error('Unknown failure disposition.')
  const reason = await editor('Reason for this decision (required)', failure.decision?.reason ?? '')
  if (reason === undefined) return
  if (!reason.trim()) throw new Error('A failure decision requires an explicit reason.')
  return { kind: 'review_failure', identity: report.identity, reportId: report.id,
    failureId: failure.id, disposition, reason }
}
