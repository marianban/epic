import type {
  TaskVerificationRecord,
  TaskDecisionRequest,
} from '../verification-types.ts'
import { currentManualReview, unresolvedReviewIds } from '../manual-review.ts'

export async function prepareLimitationsAcceptance(
  record: TaskVerificationRecord,
  confirm: (title: string, description: string) => Promise<boolean>,
  input: (title: string) => Promise<string | undefined>
): Promise<
  Extract<TaskDecisionRequest, { kind: 'accept_unresolved' }> | undefined
> {
  const review = currentManualReview(record)
  const obligations = unresolvedReviewIds(record)
  for (const id of obligations) {
    const item = review.items.find((i) => i.id === id)
    const automated = record.report?.criteria
      .flatMap((c) => c.evidence)
      .find((e) => e.obligationId === id)
    const description = item
      ? `${item.text} — ${item.status}${item.observation ? `: ${item.observation}` : ''}`
      : automated
        ? `${automated.expected} — ${automated.actual}`
        : [
            ...(record.report?.problems ?? []),
            record.report?.cycle?.review?.summary,
          ]
            .filter(Boolean)
            .join('\n')
    if (!(await confirm(`Accept limitation: ${id}`, description || id)))
      return undefined
  }
  const reason = await input('Reason for accepting these limitations')
  if (reason === undefined) return undefined
  if (!reason.trim())
    throw new Error('Accepting limitations requires a nonblank reason.')
  return {
    kind: 'accept_unresolved',
    identity: review.identity,
    reportId: review.reportId,
    obligations,
    reason,
  }
}
