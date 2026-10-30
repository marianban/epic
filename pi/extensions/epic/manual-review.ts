import type {
  HumanReviewReport,
  ManualReview,
  TaskVerificationRecord,
} from './verification-types.ts'
import type { EpicDomainState } from './types.ts'

export function createManualReview(
  state: EpicDomainState,
  report: HumanReviewReport,
  now: number
): ManualReview {
  const task = state.tasks?.[state.currentTaskIndex]
  if (!task || task.id !== report.taskId)
    throw new Error('Manual review requires the current task.')
  return {
    taskId: task.id,
    identity: report.identity,
    reportId: report.id,
    createdAt: now,
    items: task.manualReviewSteps.map((text, index) => ({
      id: `${task.id}:MR${index + 1}`,
      text,
      status: 'not_checked',
      observation: '',
      updatedAt: now,
    })),
  }
}

export function currentManualReview(
  record: TaskVerificationRecord
): ManualReview {
  const review = record.manualReviews.find(
    (r) =>
      r.reportId === record.report?.id && r.identity === record.report.identity
  )
  if (!review)
    throw new Error('No manual checklist exists for the current report.')
  return review
}

export function humanRepairFeedback(record: TaskVerificationRecord): string {
  return currentManualReview(record)
    .items.filter((i) => i.status === 'failed')
    .map((i) => `${i.id}: ${i.text}\nHuman observation: ${i.observation}`)
    .join('\n\n')
}

export function validateManualReviews(record: TaskVerificationRecord): void {
  if (
    !Array.isArray(record.manualReviews) ||
    !Array.isArray(record.humanRepairRequests)
  )
    throw new Error(
      'Incompatible task verification ledger: manual review records are required; no migration was applied.'
    )
  const reports = new Set<string>()
  for (const review of record.manualReviews) {
    if (
      !review ||
      review.taskId !== record.taskId ||
      typeof review.identity !== 'string' ||
      !review.identity ||
      typeof review.reportId !== 'string' ||
      !review.reportId ||
      reports.has(review.reportId) ||
      !Number.isFinite(review.createdAt) ||
      !Array.isArray(review.items)
    )
      throw new Error('Invalid persisted manual review.')
    reports.add(review.reportId)
    const ids = new Set<string>()
    for (const item of review.items) {
      if (
        !item ||
        typeof item.id !== 'string' ||
        !item.id ||
        ids.has(item.id) ||
        typeof item.text !== 'string' ||
        !['not_checked', 'passed', 'failed'].includes(item.status) ||
        typeof item.observation !== 'string' ||
        (item.status === 'failed' && !item.observation.trim()) ||
        !Number.isFinite(item.updatedAt)
      )
        throw new Error('Invalid persisted manual review item.')
      ids.add(item.id)
    }
  }
  for (const request of record.humanRepairRequests) {
    if (
      !request ||
      typeof request.identity !== 'string' ||
      typeof request.reportId !== 'string' ||
      typeof request.feedback !== 'string' ||
      !request.feedback.trim() ||
      !Number.isFinite(request.at) ||
      typeof request.completed !== 'boolean' ||
      (request.invocationId !== undefined &&
        !record.invocations.some(
          (i) => i.id === request.invocationId && i.kind === 'repair'
        )) ||
      (request.completed && !request.invocationId)
    )
      throw new Error('Invalid persisted human repair request.')
  }
}

export function assertManualReviewTask(
  state: EpicDomainState,
  review: ManualReview
): void {
  const task = state.tasks?.[state.currentTaskIndex]
  if (
    !task ||
    review.taskId !== task.id ||
    review.items.length !== task.manualReviewSteps.length ||
    review.items.some(
      (item, index) =>
        item.id !== `${task.id}:MR${index + 1}` ||
        item.text !== task.manualReviewSteps[index]
    )
  )
    throw new Error(
      'Manual checklist does not match the current task. Reverify the task.'
    )
}
