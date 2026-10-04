import type { EpicClock, EpicDomainState } from './types.ts'
import { appendEvent, loadEpicEvents } from './persistence.ts'

export interface PlanningChildSnapshot {
  value: unknown
  context: { domain: EpicDomainState; failureReason?: string }
  children?: unknown
}

/** Interrupted planning waits for explicit resume; it has no acceptance result to review. */
export async function recoverAcceptancePlanning(
  child: PlanningChildSnapshot,
  clock: EpicClock
): Promise<void> {
  if (
    child.value !== 'planningAcceptance' &&
    child.value !== 'replanningAcceptance'
  )
    throw new Error(
      'Acceptance planning recovery requires an active planning state.'
    )
  const state = child.context.domain
  const taskId = state.tasks?.[state.currentTaskIndex]?.id
  const events = await loadEpicEvents(state)
  const started = events
    .filter(
      (event) =>
        event.type === 'acceptance_plan_attempt_started' &&
        event.payload.taskId === taskId
    )
    .at(-1)
  const attempt = started?.payload.attempt ?? 0
  if (!Number.isSafeInteger(attempt) || (attempt as number) < 0)
    throw new Error(
      'Interrupted acceptance planning has an invalid attempt count.'
    )
  const reason = `Acceptance planning interrupted after ${attempt} attempt(s). Explicit resume retries planning; implementation and verification were not started by this planning phase.`
  await appendEvent(
    state,
    'acceptance_planning_failed',
    clock.now(),
    'acceptance_plan_failed',
    {
      taskId,
      attempt,
      batchId: started?.payload.batchId,
      invocationId: started?.payload.invocationId,
      category: 'interrupted',
      issues: [],
      reason,
      exhausted: false,
    }
  )
  child.value =
    child.value === 'planningAcceptance'
      ? 'acceptancePlanningFailed'
      : 'acceptanceReplanningFailed'
  child.children = {}
  child.context.failureReason = reason
  child.context.domain = {
    ...state,
    failureReason: reason,
    lastVerificationReportPath: undefined,
    verificationReadiness: undefined,
  }
}

export function acceptancePlanningFailureMessage(taskState: string): string {
  if (taskState === 'acceptancePlanningFailed')
    return 'Acceptance planning failed; implementation has not started for this task'
  if (taskState === 'acceptanceReplanningFailed')
    return 'Acceptance replanning failed; verification is paused'
  throw new Error(`Unknown acceptance planning failure state: ${taskState}.`)
}
