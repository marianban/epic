import { editFailureReview } from './failure-review-editor.ts'
import { editManualReviewItem } from './manual-review-editor.ts'
import { manualReviewSubmission } from './manual-review-submission.ts'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { DashboardAction } from './types.ts'
import { loadActiveEpic } from '../persistence.ts'
import { domainFromActorSnapshot } from '../domain-validation.ts'
import {
  VerificationStore,
  taskVerificationPath,
} from '../verification-store.ts'
import { currentManualReview } from '../manual-review.ts'
import { approveTask, submitTaskDecision, repairTaskCommand } from '../epic.ts'

let updateQueue: Promise<void> = Promise.resolve()

export function executeManualReviewAction(
  action: DashboardAction,
  ctx: ExtensionContext
): Promise<void> {
  const operation = updateQueue.then(() => execute(action, ctx))
  updateQueue = operation.catch(() => undefined)
  return operation
}

async function execute(
  action: DashboardAction,
  ctx: ExtensionContext
): Promise<void> {
  if (action.disabled) throw new Error('This review action is disabled.')
  const envelope = await loadActiveEpic(ctx.cwd)
  const state = domainFromActorSnapshot(envelope.snapshot)
  const now = Date.now()
  const record = await new VerificationStore(taskVerificationPath(state), {
    now: () => new Date(now).toISOString(),
    nowMs: () => now,
  }).read()
  const review = currentManualReview(record)
  if (
    action.manualReview?.reportId !== review.reportId ||
    action.manualReview.identity !== review.identity
  )
    throw new Error(
      'This review action belongs to a stale report. Refresh the dashboard.'
    )
  if (action.id === 'failure-review-update') {
    const request = await editFailureReview(record, action.itemId, action.failureStatus,
      (title, value) => ctx.ui.editor(title, value))
    if (request) await submitTaskDecision(ctx, request)
    return
  }
  if (action.id === 'manual-review-history') {
    const entries = record.manualReviews.map(
      (r, index) =>
        `Review ${index + 1}${r.reportId === review.reportId ? ' (current)' : ''}: ${r.items.filter((i) => i.status === 'passed').length} passed, ${r.items.filter((i) => i.status === 'failed').length} failed, ${r.items.filter((i) => i.status === 'not_checked').length} not checked`
    )
    const selected = await ctx.ui.select('Manual review history', entries)
    if (selected !== undefined) {
      const saved = record.manualReviews[entries.indexOf(selected)]
      if (!saved) throw new Error('Unknown review history selection.')
      const details = saved.items
        .map(
          (item, index) =>
            `${index + 1}. ${item.text} — ${item.status.replace('_', ' ')}${item.observation ? `\n   ${item.observation}` : ''}`
        )
        .join('\n')
      const decisions = record.decisions.filter(d => d.reportId === saved.reportId && d.identity === saved.identity)
        .map(d => `${d.kind}: ${d.obligations.join(', ')} — ${d.reason}`).join('\n')
      await ctx.ui.select(`${selected}\n\n${details || 'No manual steps.'}\n${decisions}`, [
        'Back',
      ])
    }
    return
  }
  if (action.id === 'manual-review-submit') {
    const submission = manualReviewSubmission(record)
    if (submission.kind === 'grant') {
      await repairTaskCommand(ctx, '')
      return
    }
    if (submission.kind === 'approve') {
      await approveTask(ctx)
      return
    }
    throw new Error('Complete all manual review steps before continuing.')
  }
  if (action.id !== 'manual-review-update')
    throw new Error(`Unsupported manual review action: ${action.id}`)
  const request = await editManualReviewItem(
    review,
    action.itemId,
    action.status,
    (title, value) => ctx.ui.editor(title, value)
  )
  if (request) await submitTaskDecision(ctx, request)
}
