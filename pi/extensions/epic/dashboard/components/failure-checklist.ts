import type { FailureReviewItem, FailureReviewStatus } from '../types.ts'

export function nextFailureStatus(status: FailureReviewStatus): FailureReviewStatus {
  switch (status) {
    case 'not_checked': return 'passed'
    case 'passed': return 'failed'
    case 'failed': return 'ignored'
    case 'ignored': return 'passed'
  }
}

export function failureChecklistLines(items: readonly FailureReviewItem[], selected: number | undefined): string[] {
  const counts = (['passed', 'failed', 'ignored', 'not_checked'] as const)
    .map(status => `${items.filter(i => i.status === status).length} ${status.replace('_', ' ')}`)
    .join(' · ')
  return [
    `Failure Review Steps — ${counts}`,
    ...items.flatMap((item, index) => [
      `${selected === index ? '▸' : ' '}[${{ passed: '✓', failed: '✕', ignored: '−', not_checked: ' ' }[item.status]}] ${index + 1}. ${item.text}`,
      ...(item.observation ? [`    Observation: ${item.observation}`] : []),
    ]),
    `↑/↓ select · Space: Pass → Fail → Ignored · ${selected !== undefined && items[selected]?.status === 'not_checked' ? 'Mark a status before adding an observation' : 'Enter: observation'} · Tab: actions`,
  ]
}
