import type {
  CheckSuiteResult,
  EpicEvent,
  EpicStage,
  EpicState,
  EpicTask,
} from '../types.ts'
import {
  type DashboardAction,
  type DashboardActionRequest,
  type DashboardProjection,
  type DashboardProjectionInput,
  type EpicDashboardState,
  type EpicDashboardStatus,
  type ProgressMetric,
  type TokenUsage,
} from './types.ts'

const STAGE_STATUS: Record<EpicStage, EpicDashboardStatus> = {
  idle: 'in-progress',
  classifying: 'in-progress',
  scouting: 'in-progress',
  planning: 'in-progress',
  awaiting_plan_review: 'review',
  revising_plan: 'refinement',
  awaiting_plan_approval: 'review',
  decomposing_tasks: 'decomposing',
  awaiting_task_approval: 'review',
  awaiting_task_review: 'review',
  revising_task: 'refinement',
  checking_prerequisites: 'decomposed',
  awaiting_prerequisite_approval: 'review',
  preparing_prerequisites: 'decomposed',
  implementing: 'in-progress',
  running_fast_checks: 'in-progress',
  repairing_fast_checks: 'in-progress',
  running_full_checks: 'in-progress',
  repairing_full_checks: 'in-progress',
  reviewing: 'in-progress',
  repairing_review: 'in-progress',
  escalating: 'escalating',
  final_verification: 'in-progress',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'failed',
}

function timestampMs(value: string, field: string): number {
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid ${field} timestamp: ${value}`)
  }
  return parsed
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer.`)
  }
  return value
}

function nonNegativeNumber(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative number.`)
  }
  return value
}

function requiredPayloadString(
  event: EpicEvent,
  field: string
): string {
  const value = event.payload[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `Event ${event.id} has an invalid ${field}; agent events require a non-empty string.`
    )
  }
  return value
}

function progress(completed: number, total: number): ProgressMetric {
  if (completed > total) {
    throw new Error(
      `Progress cannot exceed its total: completed=${completed}, total=${total}.`
    )
  }
  return {
    completed,
    total,
    percent: total === 0 ? 0 : (completed / total) * 100,
  }
}

function dashboardStatus(state: EpicState): EpicDashboardStatus {
  const status = STAGE_STATUS[state.stage]
  if (status === undefined) {
    throw new Error(`Unsupported epic stage: ${String(state.stage)}`)
  }
  return status
}

function action(
  id: string,
  label: string,
  command: string,
  kind: DashboardAction['kind']
): DashboardAction {
  return { id, label, command, kind }
}

function planReviewActions(): readonly DashboardAction[] {
  return [
    action('plan-review', 'Plan review', '/plan-review', 'primary'),
    action('plan-approve', 'Approve plan', '/plan-approve', 'primary'),
    action('abort', 'Abort', '/epic-cancel', 'danger'),
  ]
}

function planApprovalActions(): readonly DashboardAction[] {
  return [
    action('plan-approve', 'Approve plan', '/plan-approve', 'primary'),
    action('plan-review', 'Plan review', '/plan-review', 'secondary'),
    action('abort', 'Abort', '/epic-cancel', 'danger'),
  ]
}

function taskReviewActions(): readonly DashboardAction[] {
  return [
    action('task-review', 'Task review', '/task-review', 'primary'),
    action('task-approve', 'Approve task', '/task-approve', 'primary'),
    action('abort', 'Abort', '/epic-cancel', 'danger'),
  ]
}

function actionRequired(state: EpicState): DashboardActionRequest | undefined {
  switch (state.stage) {
    case 'awaiting_plan_review':
      return {
        id: 'plan-review-required',
        severity: 'warning',
        title: 'Plan is ready for review',
        actions: planReviewActions(),
      }
    case 'awaiting_plan_approval':
      return {
        id: 'plan-approval-required',
        severity: 'warning',
        title: 'Plan is ready for approval',
        actions: planApprovalActions(),
      }
    case 'awaiting_prerequisite_approval':
      return {
        id: 'prerequisite-approval-required',
        severity: 'warning',
        title: 'Repository prerequisites require approval',
        actions: [
          action(
            'approve-prerequisites',
            'Approve prerequisites',
            '/epic-approve-prerequisites',
            'primary'
          ),
          action('abort', 'Abort', '/epic-cancel', 'danger'),
        ],
      }
    case 'awaiting_task_approval':
    case 'awaiting_task_review':
      return {
        id: 'task-review-required',
        severity: 'warning',
        title: 'Task is ready for review',
        actions: taskReviewActions(),
      }
    case 'escalating':
      if (
        typeof state.failureReason !== 'string' ||
        state.failureReason.length === 0
      ) {
        throw new Error('Escalating epics must have a failure reason.')
      }
      return {
        id: 'epic-escalation',
        severity: 'critical',
        title: 'Epic requires intervention',
        message: state.failureReason,
        actions: [
          action('resume', 'Resume', '/epic-resume', 'primary'),
          action('abort', 'Abort', '/epic-cancel', 'danger'),
        ],
      }
    default:
      return undefined
  }
}

function declaredCheckCount(state: EpicState): number {
  return (state.tasks ?? []).reduce(
    (total, task) =>
      total + task.requiredChecks.length + task.deferredChecks.length,
    0
  )
}

function completedCheckCount(
  checkResults: readonly CheckSuiteResult[]
): number {
  return checkResults.reduce(
    (total, result) =>
      total + result.checks.filter((check) => !check.skipped).length,
    0
  )
}

function eventKey(event: EpicEvent): string {
  const role = requiredPayloadString(event, 'role')
  const actionName = requiredPayloadString(event, 'action')
  return `${role}:${actionName}`
}

interface OrderedEvent {
  readonly event: EpicEvent
  readonly timestampMs: number
}

function orderedEvents(events: readonly EpicEvent[]): readonly OrderedEvent[] {
  return events
    .map((event) => ({
      event,
      timestampMs: timestampMs(event.timestamp, `event ${event.id}`),
    }))
    .sort((left, right) => left.timestampMs - right.timestampMs)
}

function durationMs(startMs: number, endMs: number, description: string): number {
  if (endMs < startMs) {
    throw new Error(`${description} ends before it starts.`)
  }
  return endMs - startMs
}

function agentTimeMs(events: readonly EpicEvent[], endMs: number): number {
  const active = new Map<string, number[]>()
  let total = 0

  for (const { event, timestampMs: eventMs } of orderedEvents(events)) {
    if (event.type !== 'agent_started' && event.type !== 'agent_finished') {
      continue
    }

    const key = eventKey(event)
    if (event.type === 'agent_started') {
      const starts = active.get(key) ?? []
      starts.push(eventMs)
      active.set(key, starts)
      continue
    }

    const starts = active.get(key)
    if (!starts || starts.length === 0) {
      throw new Error(`Agent event ${event.id} finished without a matching start.`)
    }
    total += durationMs(starts.shift() as number, eventMs, `Agent event ${event.id}`)
    if (starts.length === 0) active.delete(key)
  }

  for (const [key, starts] of active) {
    for (const startedAt of starts) {
      total += durationMs(startedAt, endMs, `Agent activity ${key}`)
    }
  }
  return total
}

function usageValue(
  usage: Record<string, unknown>,
  keys: readonly string[],
  event: EpicEvent
): number | undefined {
  const key = keys.find((candidate) => candidate in usage)
  if (key === undefined) return undefined
  const value = usage[key]
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error(`Event ${event.id} has an invalid ${key} token count.`)
  }
  return value
}

function tokenUsageForEvent(event: EpicEvent): TokenUsage {
  const usage = event.payload.usage
  if (usage === undefined) return { total: 0 }
  if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) {
    throw new Error(`Event ${event.id} has invalid token usage.`)
  }
  const record = usage as Record<string, unknown>
  const input = usageValue(record, ['input', 'inputTokens', 'promptTokens'], event)
  const output = usageValue(
    record,
    ['output', 'outputTokens', 'completionTokens'],
    event
  )
  const cached = usageValue(
    record,
    ['cached', 'cachedTokens', 'cacheRead', 'cacheReadTokens'],
    event
  )
  const reasoning = usageValue(
    record,
    ['reasoning', 'reasoningTokens'],
    event
  )
  const explicitTotal = usageValue(
    record,
    ['total', 'totalTokens', 'tokens'],
    event
  )

  return {
    total:
      explicitTotal ??
      (input ?? 0) + (output ?? 0) + (cached ?? 0) + (reasoning ?? 0),
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cached === undefined ? {} : { cached }),
    ...(reasoning === undefined ? {} : { reasoning }),
  }
}

function addOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined && right === undefined) return undefined
  return (left ?? 0) + (right ?? 0)
}

function addTokenUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  const input = addOptional(left.input, right.input)
  const output = addOptional(left.output, right.output)
  const cached = addOptional(left.cached, right.cached)
  const reasoning = addOptional(left.reasoning, right.reasoning)
  return {
    total: left.total + right.total,
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cached === undefined ? {} : { cached }),
    ...(reasoning === undefined ? {} : { reasoning }),
  }
}

function tokenUsage(events: readonly EpicEvent[]): TokenUsage {
  return events
    .filter((event) => event.type === 'agent_finished')
    .map(tokenUsageForEvent)
    .reduce(addTokenUsage, { total: 0 })
}

function completedTaskCount(
  state: EpicState,
  tasks: readonly EpicTask[]
): number {
  const currentTaskIndex = nonNegativeInteger(
    state.currentTaskIndex,
    'currentTaskIndex'
  )
  if (state.stage === 'completed') return tasks.length
  if (tasks.length === 0) {
    if (currentTaskIndex !== 0) {
      throw new Error('An epic without tasks must have currentTaskIndex 0.')
    }
    return 0
  }
  if (currentTaskIndex >= tasks.length) {
    throw new Error('currentTaskIndex must refer to an existing task.')
  }
  return currentTaskIndex
}

function elapsedMs(createdAt: string, endMs: number): number {
  return durationMs(
    timestampMs(createdAt, 'state.createdAt'),
    endMs,
    'Epic elapsed time'
  )
}

export function projectDashboardState(
  input: DashboardProjectionInput
): DashboardProjection {
  const nowMs = timestampMs(input.now, 'now')
  const terminal = ['completed', 'failed', 'cancelled'].includes(input.state.stage)
  if (terminal && input.completedAt === undefined) {
    throw new Error('Terminal epics require completedAt.')
  }
  if (!terminal && input.completedAt !== undefined) {
    throw new Error('Only terminal epics may have completedAt.')
  }

  const completedAt = input.completedAt
  const endMs =
    completedAt === undefined ? nowMs : timestampMs(completedAt, 'completedAt')
  const tasks = input.state.tasks ?? []
  const criteriaTotal = tasks.reduce(
    (total, task) => total + task.acceptanceCriteria.length,
    0
  )
  const taskProgress = progress(
    completedTaskCount(input.state, tasks),
    tasks.length
  )
  const checkProgress = progress(
    completedCheckCount(input.checkResults),
    declaredCheckCount(input.state)
  )
  const humanWaitMs = nonNegativeNumber(input.humanWaitMs, 'humanWaitMs')
  const implementationAttempt = nonNegativeInteger(
    input.state.implementationAttempt,
    'implementationAttempt'
  )
  const repairAttempt =
    nonNegativeInteger(input.state.fastRepairAttempt, 'fastRepairAttempt') +
    nonNegativeInteger(input.state.fullRepairAttempt, 'fullRepairAttempt') +
    nonNegativeInteger(
      input.state.semanticRepairAttempt,
      'semanticRepairAttempt'
    )

  const epic: EpicDashboardState = {
    id: input.state.epicId,
    name: input.state.epic,
    status: dashboardStatus(input.state),
    startedAt: input.state.createdAt,
    ...(completedAt === undefined ? {} : { completedAt }),
    elapsedMs: elapsedMs(input.state.createdAt, endMs),
    agentTimeMs: agentTimeMs(input.events, endMs),
    humanWaitMs,
    tasks: taskProgress,
    criteria: progress(0, criteriaTotal),
    checks: checkProgress,
    tokens: tokenUsage(input.events),
    attempts: {
      implementation: implementationAttempt,
      repair: repairAttempt,
    },
  }

  return {
    epic,
    actionRequired: actionRequired(input.state),
  }
}
