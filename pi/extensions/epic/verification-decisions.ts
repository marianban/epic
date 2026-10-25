import {
  assertManualReviewTask,
  currentManualReview,
  unresolvedReviewIds,
  humanRepairFeedback,
} from './manual-review.ts'
import type { EpicDomainState, EpicClock } from './types.ts'
import type {
  TaskDecisionRequest,
  HumanReviewReport,
} from './verification-types.ts'
import {
  VerificationStore,
  taskVerificationPath,
} from './verification-store.ts'

export async function decideTask(
  state: EpicDomainState,
  request: TaskDecisionRequest,
  clock: EpicClock
): Promise<EpicDomainState> {
  if (
    ![
      'approve',
      'accept_unresolved',
      'grant',
      'revise_criteria',
      'update_manual_review',
    ].includes(request.kind)
  )
    throw new Error(`Unsupported task decision: ${request.kind}`)
  const store = new VerificationStore(taskVerificationPath(state), clock)
  const record = await store.read()
  const report = record.report
  if (!report) throw new Error('No human-review report is available.')
  const identity = report.identity
  if (
    request.kind !== 'approve' &&
    (request.identity !== identity ||
      request.reportId !== report.id ||
      !request.reason.trim())
  )
    throw new Error(
      'Decision requires the current attempt/report and an explicit reason.'
    )
  const manualReview = currentManualReview(record)
  assertManualReviewTask(state, manualReview)
  if (request.kind === 'update_manual_review') {
    const item = manualReview.items.find((i) => i.id === request.itemId)
    if (
      !item ||
      !['not_checked', 'passed', 'failed'].includes(request.status) ||
      typeof request.observation !== 'string' ||
      (request.status === 'failed' && !request.observation.trim())
    )
      throw new Error(
        'Manual review update requires a valid item, status, and an observation for failures.'
      )
    item.status = request.status
    item.observation = request.observation
    item.updatedAt = clock.nowMs()
    await store.write(record)
    return { ...state, failureReason: undefined }
  }
  const unresolved = unresolvedReviewIds(record)
  if (
    request.kind === 'approve' &&
    (report.readiness !== 'verified' || unresolved.length > 0)
  )
    throw new Error(
      `Ordinary approval is unavailable: ${report.readiness}. Acknowledge unresolved results explicitly.`
    )
  if (
    request.kind === 'accept_unresolved' &&
    ((report.readiness === 'verified' && unresolved.length === 0) ||
      !unresolved.every((id) => request.obligations.includes(id)) ||
      request.obligations.some((id) => !unresolved.includes(id)))
  )
    throw new Error(
      'Acknowledge every specific failed or unverified result in the current report.'
    )
  if (request.kind === 'grant') {
    const feedback = humanRepairFeedback(record)
    if (!feedback && report.readiness === 'verified')
      throw new Error(
        'The current task is already verified; no repair is needed.'
      )
    if (record.humanRepairRequests.some((r) => !r.completed && !r.invocationId))
      throw new Error('A human repair request is already pending.')
    if (feedback)
      record.humanRepairRequests.push({
        identity,
        reportId: report.id,
        feedback,
        at: clock.nowMs(),
        completed: false,
      })
    await store.grant(record, {
      repairs: request.repairs,
      timeMs: request.timeMs,
      reason: request.reason,
      at: clock.nowMs(),
    })
    return state
  }
  if (request.kind === 'revise_criteria') {
    if (
      !request.criteria.length ||
      request.criteria.some((c) => typeof c !== 'string' || !c.trim())
    )
      throw new Error('Criterion revision requires non-empty criteria.')
    record.criteria = request.criteria.map((text, index) => ({
      id: record.criteria[index]?.id ?? `${record.taskId}:AC${index + 1}`,
      text,
    }))
    record.criterionVersion += 1
    delete record.plan
    delete record.report
    await store.write(record)
    return {
      ...state,
      tasks: state.tasks?.map((task, index) =>
        index === state.currentTaskIndex
          ? { ...task, acceptanceCriteria: request.criteria }
          : task
      ),
      verificationReadiness: undefined,
      lastVerificationReportPath: undefined,
    }
  }
  record.decisions.push({
    kind: request.kind,
    identity,
    reportId: report.id,
    obligations:
      request.kind === 'accept_unresolved' ? request.obligations : [],
    reason:
      request.kind === 'approve'
        ? 'All requirements verified.'
        : request.reason,
    at: clock.nowMs(),
  })
  await store.write(record)
  return {
    ...state,
    taskApproved: true,
    taskApprovedAt: clock.now(),
  }
}

export async function assertAcceptedReport(
  state: EpicDomainState,
  clock: EpicClock
): Promise<HumanReviewReport> {
  const record = await new VerificationStore(
    taskVerificationPath(state),
    clock
  ).read()
  const report = record.report
  const decision = record.decisions.at(-1)
  if (
    !report ||
    !decision ||
    !['approve', 'accept_unresolved'].includes(decision.kind) ||
    decision.identity !== report.identity ||
    decision.reportId !== report.id
  )
    throw new Error(
      'Checkpoint requires acceptance of the current attempt and report.'
    )
  assertManualReviewTask(state, currentManualReview(record))
  const unresolved = unresolvedReviewIds(record)
  if (
    decision.kind === 'approve' &&
    (report.readiness !== 'verified' || unresolved.length)
  )
    throw new Error(
      'Checkpoint requires all manual review items and automated checks to pass.'
    )
  if (
    decision.kind === 'accept_unresolved' &&
    (unresolved.some((id) => !decision.obligations.includes(id)) ||
      !decision.reason.trim())
  )
    throw new Error(
      'Checkpoint requires acknowledgement of every unresolved manual and automated result.'
    )
  return report
}
