import type {
  ManualReview,
  ManualReviewStatus,
} from '../../verification-types.ts'

export function nextReviewStatus(
  status: ManualReviewStatus
): ManualReviewStatus {
  switch (status) {
    case 'not_checked':
      return 'passed'
    case 'passed':
      return 'failed'
    case 'failed':
      return 'not_checked'
  }
}

export function checklistLines(
  review: ManualReview,
  selected: number | undefined
): string[] {
  const counts = ['passed', 'failed', 'not_checked']
    .map(
      (status) =>
        `${review.items.filter((i) => i.status === status).length} ${status.replace('_', ' ')}`
    )
    .join(' · ')
  return [
    `Manual Review Steps — ${counts}`,
    ...review.items.flatMap((item, index) => [
      `${selected === index ? '▸' : ' '}[${item.status === 'passed' ? '✓' : item.status === 'failed' ? '✕' : ' '}] ${index + 1}. ${item.text}`,
      ...(item.observation ? [`    Observation: ${item.observation}`] : []),
    ]),
    '↑/↓ select · Space: Not checked → Passed → Failed · Enter: observation · Tab: actions',
  ]
}
