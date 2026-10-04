import type { EpicDomainState, EpicClock } from './types.ts'
import type {
  TaskDecisionRequest,
  HumanReviewReport,
} from './verification-types.ts'
import {
  VerificationStore,
  taskVerificationPath,
} from './verification-store.ts'
import { finalizeReviewReport } from './verification-report.ts'

export async function decideTask(
  state: EpicDomainState,
  request: TaskDecisionRequest,
  clock: EpicClock
): Promise<EpicDomainState> {
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
  if (request.kind === 'approve' && report.readiness !== 'verified')
    throw new Error(
      `Ordinary approval is unavailable: ${report.readiness}. Acknowledge unresolved results explicitly.`
    )
  if (
    request.kind === 'accept_unresolved' &&
    (report.readiness === 'verified' ||
      !report.unresolved.every((id) => request.obligations.includes(id)) ||
      request.obligations.some((id) => !report.unresolved.includes(id)))
  )
    throw new Error(
      'Acknowledge every specific failed or unverified result in the current report.'
    )
  if (request.kind === 'grant') {
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
  if (
    request.kind === 'confirm' &&
    (!request.obligations.length ||
      request.obligations.some(
        (id) =>
          !record.plan?.obligations.some(
            (o) => o.id === id && o.method === 'human_only'
          )
      ))
  )
    throw new Error(
      'Only current human-only obligations may receive human confirmation.'
    )
  record.decisions.push({
    kind: request.kind,
    identity,
    reportId: report.id,
    obligations:
      request.kind === 'accept_unresolved' || request.kind === 'confirm'
        ? request.obligations
        : [],
    reason:
      request.kind === 'approve'
        ? 'All requirements verified.'
        : request.reason,
    at: clock.nowMs(),
  })
  await store.write(record)
  if (request.kind === 'confirm')
    return finalizeReviewReport(state, record, identity, store)
  return {
    ...state,
    taskApproved: request.kind !== 'defer',
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
  return report
}
