import type {
  ManualReview,
  ManualReviewStatus,
  TaskDecisionRequest,
} from '../verification-types.ts'

export async function editManualReviewItem(
  review: ManualReview,
  itemId: string | undefined,
  targetStatus: ManualReviewStatus | undefined,
  editor: (title: string, value: string) => Promise<string | undefined>
): Promise<
  Extract<TaskDecisionRequest, { kind: 'update_manual_review' }> | undefined
> {
  const item = review.items.find((i) => i.id === itemId)
  if (!item) throw new Error('Unknown manual review item.')
  const status = targetStatus ?? item.status
  let observation = item.observation
  if (!targetStatus || status === 'failed') {
    const edited = await editor(
      `${item.text} — ${status === 'failed' ? 'Failure observation (required)' : 'Observation'}`,
      observation
    )
    if (edited === undefined) return undefined
    observation = edited
  }
  if (status === 'failed' && !observation.trim())
    throw new Error('A failed step requires a nonblank observation.')
  return {
    kind: 'update_manual_review',
    identity: review.identity,
    reportId: review.reportId,
    itemId: item.id,
    status,
    observation,
    reason: 'Human checklist update.',
  }
}
