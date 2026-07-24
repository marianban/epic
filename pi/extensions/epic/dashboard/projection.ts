import type { EpicStage, EpicState, EpicEvent, CheckSuiteResult } from '../types.ts'
import {
  type DashboardAction,
  type DashboardActionRequest,
  type DashboardProjection,
  type DashboardProjectionInput,
  type EpicDashboardStatus,
  type ProgressMetric,
  type TokenUsage,
} from './types.ts'

const HUMAN_REVIEW_STAGES = new Set<EpicStage>([
  'awaiting_plan_review',
  'awaiting_plan_approval',
  'awaiting_prerequisite_approval',
  'awaiting_task_approval',
  'awaiting_task_review',
])

const REFINEMENT_STAGES = new Set<EpicStage>([
  'revising_plan',
  'revising_task',
])

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function count(value: unknown): number {
  const numeric = finiteNumber(value)
  return numeric === undefined ? 0 : Math.max(0, Math.floor(numeric))
}

function timestampMs(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function progress(completed: unknown, total: unknown): ProgressMetric {
  const normalizedCompleted = count(completed)
  const normalizedTotal = count(total)
  const percent =
    normalizedTotal <= 0
      ? 0
      : Math.min(
          100,
          Math.max(0, (normalizedCompleted / normalizedTotal) * 100)
        )
  return {
    completed: normalizedCompleted,
    total: normalizedTotal,
    percent,
  }
}

function dashboardStatus(state: EpicState): EpicDashboardStatus {
  if (HUMAN_REVIEW_STAGES.has(state.stage)) return 'review'
  if (REFINEMENT_STAGES.has(state.stage)) return 'refinement'

  switch (state.stage) {
    case 'decomposing_tasks':
      return 'decomposing'
    case 'checking_prerequisites':
    case 'preparing_prerequisites':
      return 'decomposed'
    case 'completed':
      return 'completed'
    case 'failed':
    case 'cancelled':
      return 'failed'
    case 'escalating':
      return 'escalating'
    default:
      return 'in-progress'
  }
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
  checkResults: readonly CheckSuiteResult[] | undefined
): number {
  return (checkResults ?? []).reduce(
    (total, result) =>
      total + result.checks.filter((check) => !check.skipped).length,
    0
  )
}

function eventKey(event: EpicEvent): string {
  const role = event.payload.role
  const actionName = event.payload.action
  return `${typeof role === 'string' ? role : ''}:${typeof actionName === 'string' ? actionName : ''}`
}

function agentTimeMs(
  events: readonly EpicEvent[] | undefined,
  endMs: number
): number {
  const active = new Map<string, number[]>()
  let total = 0
  const ordered = [...(events ?? [])].sort(
    (left, right) =>
      (timestampMs(left.timestamp) ?? Number.MAX_SAFE_INTEGER) -
      (timestampMs(right.timestamp) ?? Number.MAX_SAFE_INTEGER)
  )

  for (const event of ordered) {
    const eventMs = timestampMs(event.timestamp)
    if (eventMs === undefined) continue
    const key = eventKey(event)
    if (event.type === 'agent_started') {
      const starts = active.get(key) ?? []
      starts.push(eventMs)
      active.set(key, starts)
      continue
    }
    if (event.type !== 'agent_finished') continue

    const starts = active.get(key)
    const startedAt = starts?.shift()
    if (startedAt !== undefined) total += Math.max(0, eventMs - startedAt)
    if (starts?.length === 0) active.delete(key)
  }

  for (const starts of active.values()) {
    for (const startedAt of starts) total += Math.max(0, endMs - startedAt)
  }
  return count(total)
}

function usageNumber(
  usage: Record<string, unknown>,
  keys: readonly string[]
): number | undefined {
  for (const key of keys) {
    const value = finiteNumber(usage[key])
    if (value !== undefined) return Math.max(0, value)
  }
  return undefined
}

function tokenUsage(events: readonly EpicEvent[] | undefined): TokenUsage {
  let total = 0
  let input = 0
  let output = 0
  let cached = 0
  let reasoning = 0
  let hasInput = false
  let hasOutput = false
  let hasCached = false
  let hasReasoning = false

  for (const event of events ?? []) {
    if (event.type !== 'agent_finished') continue
    const usage = event.payload.usage
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) continue
    const record = usage as Record<string, unknown>
    const inputValue = usageNumber(record, ['input', 'inputTokens', 'promptTokens'])
    const outputValue = usageNumber(record, [
      'output',
      'outputTokens',
      'completionTokens',
    ])
    const cachedValue = usageNumber(record, [
      'cached',
      'cachedTokens',
      'cacheRead',
      'cacheReadTokens',
    ])
    const reasoningValue = usageNumber(record, [
      'reasoning',
      'reasoningTokens',
    ])
    const explicitTotal = usageNumber(record, [
      'total',
      'totalTokens',
      'tokens',
    ])

    if (inputValue !== undefined) {
      input += inputValue
      hasInput = true
    }
    if (outputValue !== undefined) {
      output += outputValue
      hasOutput = true
    }
    if (cachedValue !== undefined) {
      cached += cachedValue
      hasCached = true
    }
    if (reasoningValue !== undefined) {
      reasoning += reasoningValue
      hasReasoning = true
    }
    total +=
      explicitTotal ??
      (inputValue ?? 0) +
        (outputValue ?? 0) +
        (cachedValue ?? 0) +
        (reasoningValue ?? 0)
  }

  return {
    total: count(total),
    ...(hasInput ? { input: count(input) } : {}),
    ...(hasOutput ? { output: count(output) } : {}),
    ...(hasCached ? { cached: count(cached) } : {}),
    ...(hasReasoning ? { reasoning: count(reasoning) } : {}),
  }
}

function completedTaskCount(state: EpicState): number {
  if (!state.tasks?.length) return 0
  if (state.stage === 'completed') return state.tasks.length
  return count(state.currentTaskIndex)
}

function elapsedMs(
  state: EpicState,
  completedAt: string | undefined,
  now: string
): number {
  const started = timestampMs(state.createdAt)
  const end = timestampMs(completedAt ?? now)
  if (started === undefined || end === undefined) return 0
  return count(Math.max(0, end - started))
}

export function projectDashboardState(
  input: DashboardProjectionInput
): DashboardProjection {
  const updatedAt = input.now ?? new Date().toISOString()
  const terminal = ['completed', 'failed', 'cancelled'].includes(input.state.stage)
  const completedAt = terminal
    ? input.completedAt ?? input.state.updatedAt
    : undefined
  const endMs = timestampMs(completedAt ?? updatedAt) ?? Date.now()
  const tasks = input.state.tasks ?? []
  const criteriaTotal = tasks.reduce(
    (total, task) => total + task.acceptanceCriteria.length,
    0
  )
  const taskProgress = progress(completedTaskCount(input.state), tasks.length)
  const checkProgress = progress(
    completedCheckCount(input.checkResults),
    declaredCheckCount(input.state)
  )

  const epic = {
    id: input.state.epicId,
    name: input.state.epic,
    status: dashboardStatus(input.state),
    startedAt: input.state.createdAt,
    ...(completedAt ? { completedAt } : {}),
    elapsedMs: elapsedMs(input.state, completedAt, updatedAt),
    agentTimeMs: agentTimeMs(input.events, endMs),
    humanWaitMs: count(input.timing?.humanWaitMs),
    tasks: taskProgress,
    criteria: progress(0, criteriaTotal),
    checks: checkProgress,
    tokens: tokenUsage(input.events),
    attempts: {
      implementation: count(input.state.implementationAttempt),
      repair: count(
        input.state.fastRepairAttempt +
          input.state.fullRepairAttempt +
          input.state.semanticRepairAttempt
      ),
    },
  }

  return {
    epic,
    actionRequired: actionRequired(input.state),
  }
}
