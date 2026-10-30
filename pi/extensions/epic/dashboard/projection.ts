import { currentManualReview } from '../manual-review.ts'
import { canApproveTask, canRepairTask } from '../task-review-policy.ts'
import { manualReviewSubmission } from './manual-review-submission.ts'
import { acceptancePlanningFailureMessage } from '../acceptance-planning-recovery.ts'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { hyperlink } from '@earendil-works/pi-tui'
import type {
  EpicDomainState,
  EpicEvent,
  EpicStage,
  EpicTask,
  PendingHumanAction,
} from '../types.ts'
import { currentTaskArtifactPath } from '../artifact-paths.ts'
import {
  EPIC_COMMANDS,
  type EpicCommandName,
  slashCommand,
} from '../commands.ts'
import {
  type DashboardAction,
  type DashboardActionRequest,
  type ActiveAgentRun,
  type DashboardProjection,
  type DashboardProjectionInput,
  type EpicDashboardState,
  type EpicDashboardStatus,
  type CurrentTaskDashboardState,
  type TaskDashboardStatus,
  type TaskDiffDashboardState,
  type ProgressMetric,
  type TokenUsage,
} from './types.ts'
import { projectPipelineState } from './pipeline-projection.ts'

const STAGE_STATUS: Record<EpicStage, EpicDashboardStatus> = {
  planning_acceptance: 'in-progress',
  acceptance_planning_failed: 'escalating',
  verifying_acceptance: 'in-progress',
  finalizing_report: 'in-progress',
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
  starting_dev_server: 'in-progress',
  running_browser_smoke: 'in-progress',
  repairing_browser_smoke: 'in-progress',
  reviewing: 'in-progress',
  repairing_review: 'in-progress',
  escalating: 'escalating',
  recovering: 'escalating',
  final_verification: 'in-progress',
  completed: 'completed',
  failed: 'failed',
}

interface DashboardRunState extends EpicDomainState {
  stage: EpicStage
  createdAt: string
  updatedAt: string
  pendingHumanAction?: PendingHumanAction
}

function timestampMs(value: string, field: string): number {
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid ${field} timestamp: ${value}`)
  }
  return parsed
}

function nonNegativeInteger(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer.`)
  }
  return value
}

function requiredPayloadString(event: EpicEvent, field: string): string {
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

function dashboardStatus(state: DashboardRunState): EpicDashboardStatus {
  const status = STAGE_STATUS[state.stage]
  if (status === undefined) {
    throw new Error(`Unsupported epic stage: ${String(state.stage)}`)
  }
  return status
}

function action(
  id: string,
  label: string,
  command: EpicCommandName,
  kind: DashboardAction['kind']
): DashboardAction {
  return { id, label, command: slashCommand(command), kind }
}

function planActions(): readonly DashboardAction[] {
  return [
    action(
      EPIC_COMMANDS.approvePlan,
      'Continue',
      EPIC_COMMANDS.approvePlan,
      'primary'
    ),
    action(EPIC_COMMANDS.exit, 'Exit', EPIC_COMMANDS.exit, 'secondary'),
  ]
}

function taskActions(): readonly DashboardAction[] {
  return [
    action(
      EPIC_COMMANDS.approveTask,
      'Continue',
      EPIC_COMMANDS.approveTask,
      'primary'
    ),
    action(EPIC_COMMANDS.exit, 'Exit', EPIC_COMMANDS.exit, 'secondary'),
  ]
}

function linkedFile(filePath: string, label: string): string {
  return hyperlink(label, pathToFileURL(filePath).toString())
}

function planMessage(state: DashboardRunState): string {
  const verb = state.planRevision > 1 ? 'refined' : 'created'
  const plan = linkedFile(state.planPath, 'plan.md')
  return `${plan} has been ${verb}. Comments marked with R: will be refined.`
}

function taskMessage(state: DashboardRunState): string {
  const task = linkedFile(
    currentTaskArtifactPath(state),
    `task-${String(state.currentTaskIndex + 1).padStart(3, '0')}.md`
  )
  return `${task} is ready. Comments marked with R: will be refined.`
}

function taskReviewMessage(
  state: DashboardRunState,
  readiness: EpicDomainState['verificationReadiness'],
  manualFailures: boolean,
  manualApprovalReady: boolean
): string | undefined {
  if (readiness === 'verified' && !manualFailures) return undefined
  if (manualApprovalReady)
    return 'All manual review steps passed. Continue to approve the task.'

  const status = manualFailures
    ? 'Manual review found incorrect behavior. Repair will use the recorded observations.'
    : readiness === 'issues_remaining'
    ? 'Verification found unresolved issues.'
    : 'Verification needs manual confirmation.'
  const instructions = state.lastVerificationReportPath
    ? [
        canRepairTask(readiness, manualFailures)
          ? 'Use /task-repair without arguments to grant one additional repair attempt and five minutes.'
          : 'No actionable failure is recorded. Review the unresolved evidence manually.',
        'Complete the manual review steps, then choose Continue.',
      ].join(' ')
    : 'No verification report is available for this task.'
  return [status, state.failureReason, instructions].filter(Boolean).join(' ')
}

function currentTaskDefinition(state: DashboardRunState): EpicTask {
  const index = nonNegativeInteger(state.currentTaskIndex, 'currentTaskIndex')
  const task = state.tasks?.[index]
  if (task === undefined) {
    throw new Error(`currentTaskIndex must refer to an existing task.`)
  }
  return task
}

function actionRequired(
  state: DashboardRunState,
  activeOperation: boolean,
  boundaryFailureReason: string | undefined,
  taskState: string | undefined,
  recovery: DashboardProjectionInput['boundary']['recoveryDiagnostics'],
  verificationRecord: DashboardProjectionInput['verificationRecord']
): DashboardActionRequest | undefined {
  if (activeOperation) return undefined

  switch (state.stage) {
    case 'awaiting_plan_review':
      return {
        id: 'plan-action-required',
        severity: 'warning',
        title: 'Plan is ready',
        message: planMessage(state),
        actions: planActions(),
      }
    case 'awaiting_plan_approval':
      return {
        id: 'plan-action-required',
        severity: 'warning',
        title: 'Plan is ready',
        message: planMessage(state),
        actions: planActions(),
      }
    case 'awaiting_prerequisite_approval':
      return {
        id: 'prerequisite-approval-required',
        severity: 'warning',
        title: 'Repository prerequisites require approval',
        actions: [
          action(
            EPIC_COMMANDS.approvePrerequisites,
            'Approve prerequisites',
            EPIC_COMMANDS.approvePrerequisites,
            'primary'
          ),
          action(EPIC_COMMANDS.exit, 'Exit', EPIC_COMMANDS.exit, 'secondary'),
        ],
      }
    case 'awaiting_task_approval':
      return {
        id: 'task-action-required',
        severity: 'warning',
        title: 'Task is ready',
        message: taskMessage(state),
        actions: taskActions(),
      }
    case 'acceptance_planning_failed':
      return {
        id: 'acceptance-planning-failed',
        severity: 'critical',
        title: acceptancePlanningFailureMessage(taskState ?? ''),
        message: state.failureReason ?? boundaryFailureReason,
        actions: [
          action(EPIC_COMMANDS.resume, 'Retry acceptance planning', EPIC_COMMANDS.resume, 'primary'),
          action(EPIC_COMMANDS.exit, 'Exit', EPIC_COMMANDS.exit, 'secondary'),
        ],
      }
    case 'awaiting_task_review':
      {
        const task = currentTaskDefinition(state)
        const manualReview = verificationRecord ? currentManualReview(verificationRecord) : undefined
        const readiness = verificationRecord?.report ? verificationRecord.report.readiness : state.verificationReadiness
        const manualFailures = manualReview?.items.some((item) => item.status === 'failed') ?? false
        const manualApprovalReady = verificationRecord?.report ? canApproveTask(verificationRecord) : false
        const repairActions = canRepairTask(readiness, manualFailures)
          ? [action(EPIC_COMMANDS.repairTask, 'Repair', EPIC_COMMANDS.repairTask, 'secondary')]
          : []
        const reviewActions: DashboardAction[] | undefined = manualReview && verificationRecord?.report ? [
          { id: 'manual-review-submit', label: manualReviewSubmission(verificationRecord).label, kind: 'primary', manualReview, disabled: manualReviewSubmission(verificationRecord).kind === 'incomplete' },
          ...repairActions,
          { id: 'manual-review-history', label: 'Review history', manualReview },
          action(EPIC_COMMANDS.exit, 'Exit', EPIC_COMMANDS.exit, 'secondary'),
        ] : undefined
        return {
          id: 'task-action-required',
          severity: 'warning',
          title: 'Task awaits human review',
          message: taskReviewMessage(state, readiness, manualFailures, manualApprovalReady),
          manualReview,
          manualReviewSteps: task.manualReviewSteps,
          verificationReportLink: state.lastVerificationReportPath
            ? linkedFile(state.lastVerificationReportPath.replace(/\.json$/, '.md'), 'Verification report')
            : undefined,
          actions: reviewActions ?? (readiness === 'verified' ? taskActions() : [...repairActions, action(EPIC_COMMANDS.exit, 'Exit', EPIC_COMMANDS.exit, 'secondary')]),
        }
      }
    case 'escalating': {
      const failureReason = state.failureReason ?? boundaryFailureReason
      if (
        typeof failureReason !== 'string' ||
        failureReason.length === 0
      ) {
        throw new Error('Escalating epics must have a failure reason.')
      }
      return {
        id: 'epic-escalation',
        severity: 'critical',
        title: 'Epic requires intervention',
        message: failureReason,
        actions: [
          action(
            EPIC_COMMANDS.resume,
            'Resume',
            EPIC_COMMANDS.resume,
            'primary'
          ),
          action(EPIC_COMMANDS.exit, 'Exit', EPIC_COMMANDS.exit, 'secondary'),
        ],
      }
    }
    case 'recovering': {
      if (!recovery) throw new Error('Recovering epics require diagnostics.')
      const paths = recovery.changedPaths.length
        ? ` Changed paths: ${recovery.changedPaths.map(({ path, kind }) => `${kind} ${path}`).join(', ')}.`
        : ''
      const label = recovery.action === 'adopt-head'
        ? 'Approve new HEAD & retry'
        : recovery.requiresRevalidation
          ? 'Adopt changes & revalidate'
          : 'Approve retry'
      return {
        id: 'epic-recovery',
        severity: 'critical',
        title: 'Epic recovery requires approval',
        message: `${recovery.reason}${paths}`,
        actions: [
          action(EPIC_COMMANDS.approveRecovery, label, EPIC_COMMANDS.approveRecovery, 'primary'),
          action(EPIC_COMMANDS.exit, 'Exit', EPIC_COMMANDS.exit, 'secondary'),
        ],
      }
    }
    case 'failed':
      return {
        id: 'epic-failure',
        severity: 'critical',
        title: 'Epic failed',
        message: state.failureReason ?? 'The epic stopped because of an unrecoverable failure.',
        actions: [
          action(EPIC_COMMANDS.exit, 'Exit', EPIC_COMMANDS.exit, 'secondary'),
        ],
      }
    default:
      return undefined
  }
}

function eventKey(event: EpicEvent): string {
  const role = requiredPayloadString(event, 'role')
  const actionName = requiredPayloadString(event, 'action')
  return `${role}:${actionName}`
}

function agentDurationMs(event: EpicEvent): number | undefined {
  const value = event.payload.durationMs
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Event ${event.id} has an invalid agent duration.`)
  }
  return value
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

function agentTimeMs(
  events: readonly EpicEvent[],
  activeAgentRuns: readonly ActiveAgentRun[],
  nowMs: number
): number {
  const active = new Map<string, number>()
  const intervals: (readonly [number, number])[] = []

  for (const { event, timestampMs: eventMs } of orderedEvents(events)) {
    if (event.type !== 'agent_started' && event.type !== 'agent_finished') {
      continue
    }

    const key = eventKey(event)
    if (event.type === 'agent_started') {
      const previous = active.get(key)
      if (previous !== undefined) {
        intervals.push([previous, eventMs])
      }
      // A repeated start means the previous invocation was abandoned before
      // it could write its finish event. Close it at the retry start instead
      // of dropping the elapsed time or letting it contribute forever.
      active.set(key, eventMs)
      continue
    }

    const startedAt = active.get(key)
    if (startedAt === undefined) {
      throw new Error(
        `Agent event ${event.id} finished without a matching start.`
      )
    }
    if (eventMs < startedAt) {
      throw new Error(`Agent event ${event.id} ends before it starts.`)
    }
    const duration = agentDurationMs(event)
    const finishedAt = startedAt + (duration ?? eventMs - startedAt)
    intervals.push([startedAt, finishedAt])
    active.delete(key)
  }

  for (const startedAt of active.values()) {
    intervals.push([startedAt, nowMs])
  }

  for (const run of activeAgentRuns) {
    if (!Number.isInteger(run.startedAtMs) || run.startedAtMs < 0) {
      throw new Error(
        'Active agent runs require non-negative integer timestamps.'
      )
    }
    if (run.startedAtMs > nowMs) {
      throw new Error('Active agent runs cannot start after now.')
    }
    intervals.push([run.startedAtMs, nowMs])
  }

  // Agent time is the wall-clock time covered by completed or currently
  // running agent calls. Merge overlaps so parallel or duplicated lifecycle
  // events cannot double-count time.
  intervals.sort(([left], [right]) => left - right)
  let total = 0
  let mergedStart: number | undefined
  let mergedEnd: number | undefined
  for (const [start, end] of intervals) {
    if (mergedStart === undefined || mergedEnd === undefined) {
      mergedStart = start
      mergedEnd = end
    } else if (start <= mergedEnd) {
      mergedEnd = Math.max(mergedEnd, end)
    } else {
      total += mergedEnd - mergedStart
      mergedStart = start
      mergedEnd = end
    }
  }
  if (mergedStart !== undefined && mergedEnd !== undefined) {
    total += mergedEnd - mergedStart
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
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
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
  const input = usageValue(
    record,
    ['input', 'inputTokens', 'promptTokens'],
    event
  )
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
  const reasoning = usageValue(record, ['reasoning', 'reasoningTokens'], event)
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

function addOptional(
  left: number | undefined,
  right: number | undefined
): number | undefined {
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
  state: DashboardRunState,
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

const TASK_STAGES = new Set<EpicStage>([
  'awaiting_task_approval',
  'planning_acceptance',
  'acceptance_planning_failed',
  'verifying_acceptance',
  'finalizing_report',
  'awaiting_task_review',
  'revising_task',
  'implementing',
  'running_fast_checks',
  'repairing_fast_checks',
  'running_full_checks',
  'repairing_full_checks',
  'starting_dev_server',
  'running_browser_smoke',
  'repairing_browser_smoke',
  'reviewing',
  'repairing_review',
  'escalating',
])

function taskIdFromEvent(event: EpicEvent): string | undefined {
  const value = event.payload.taskId
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Event ${event.id} has an invalid taskId.`)
  }
  return value
}

function taskEvents(
  events: readonly EpicEvent[],
  type: string,
  taskId: string
): readonly EpicEvent[] {
  return orderedEvents(events)
    .map(({ event }) => event)
    .filter((event) => event.type === type && taskIdFromEvent(event) === taskId)
}

function taskAgentTimeMs(
  events: readonly EpicEvent[],
  activeAgentRuns: readonly ActiveAgentRun[],
  taskId: string,
  nowMs: number
): number {
  return agentTimeMs(
    events.filter((event) => taskIdFromEvent(event) === taskId),
    activeAgentRuns.filter((run) => run.taskId === taskId),
    nowMs
  )
}

function taskAttempt(
  events: readonly EpicEvent[],
  taskId: string
): { readonly current: number } {
  const implementations = events.filter(
    (event) =>
      event.type === 'agent_started' &&
      taskIdFromEvent(event) === taskId &&
      event.payload.role === 'implementer' &&
      event.payload.action === 'implementation'
  )
  return { current: Math.max(1, implementations.length) }
}

function nonNegativeEventInteger(event: EpicEvent, field: string): number {
  const value = event.payload[field]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Event ${event.id} has an invalid ${field}.`)
  }
  return value
}

function taskCriteria(
  events: readonly EpicEvent[],
  taskId: string,
  total: number
): ProgressMetric {
  const latest = taskEvents(events, 'task_review_completed', taskId).at(-1)
  if (latest === undefined) return progress(0, total)
  const completed = nonNegativeEventInteger(latest, 'criteriaCompleted')
  const recordedTotal = nonNegativeEventInteger(latest, 'criteriaTotal')
  if (recordedTotal !== total) {
    throw new Error(
      `Event ${latest.id} criteria total ${recordedTotal} does not match task total ${total}.`
    )
  }
  return progress(completed, total)
}

function taskDiff(
  events: readonly EpicEvent[],
  taskId: string
): TaskDiffDashboardState | undefined {
  const latest = taskEvents(events, 'task_diff_updated', taskId).at(-1)
  if (latest === undefined) return undefined
  return {
    filesChanged: nonNegativeEventInteger(latest, 'filesChanged'),
    linesAdded: nonNegativeEventInteger(latest, 'linesAdded'),
    linesDeleted: nonNegativeEventInteger(latest, 'linesDeleted'),
  }
}

function taskAgentName(
  activeAgentRuns: readonly ActiveAgentRun[],
  taskId: string
): string | undefined {
  const role = activeAgentRuns
    .filter((run) => run.taskId === taskId)
    .at(-1)?.role
  if (role === undefined) return undefined
  switch (role) {
    case 'implementer':
      return 'Implementor'
    case 'reviewer':
      return 'Reviewer'
    case 'task-reviewer':
      return 'Task Reviewer'
    case 'scout':
      return 'Scout'
    default:
      return role
  }
}

function taskStatus(
  stage: EpicStage,
  events: readonly EpicEvent[],
  taskId: string
): TaskDashboardStatus {
  switch (stage) {
    case 'awaiting_task_approval':
      return taskEvents(events, 'task_revised', taskId).length > 0
        ? 'refinement'
        : 'initial-review'
    case 'revising_task':
      return 'refinement'
    case 'awaiting_task_review':
      return 'completed'
    case 'acceptance_planning_failed':
    case 'escalating':
      return 'failed'
    case 'planning_acceptance':
    case 'verifying_acceptance':
    case 'finalizing_report':
    case 'implementing':
    case 'running_fast_checks':
    case 'repairing_fast_checks':
    case 'running_full_checks':
    case 'repairing_full_checks':
    case 'starting_dev_server':
    case 'running_browser_smoke':
    case 'repairing_browser_smoke':
    case 'reviewing':
    case 'repairing_review':
      return 'in-progress'
    default:
      throw new Error(`Unsupported current-task stage: ${stage}`)
  }
}

function currentTask(
  input: DashboardProjectionInput,
  state: DashboardRunState,
  tasks: readonly EpicTask[],
  nowMs: number
): CurrentTaskDashboardState | undefined {
  if (!TASK_STAGES.has(state.stage) || tasks.length === 0) {
    return undefined
  }
  const index = nonNegativeInteger(state.currentTaskIndex, 'currentTaskIndex')
  const task = tasks[index]
  if (task === undefined) {
    throw new Error(`currentTaskIndex must refer to an existing task.`)
  }
  const taskId = task.id
  const activeAgentRuns = input.activeAgentRuns ?? []
  return {
    id: taskId,
    index: index + 1,
    totalTasks: tasks.length,
    name: task.title,
    status: taskStatus(state.stage, input.events, taskId),
    agentTimeMs: taskAgentTimeMs(input.events, activeAgentRuns, taskId, nowMs),
    attempt: input.boundary.task?.state === 'planningAcceptance' || input.boundary.task?.state === 'acceptancePlanningFailed'
      ? { current: 0 }
      : taskAttempt(input.events, taskId),
    criteria: state.stage === 'planning_acceptance' || state.stage === 'acceptance_planning_failed'
      ? progress(0, task.acceptanceCriteria.length)
      : taskCriteria(input.events, taskId, task.acceptanceCriteria.length),
    ...(taskAgentName(activeAgentRuns, taskId) === undefined
      ? {}
      : { agent: taskAgentName(activeAgentRuns, taskId) }),
    ...(taskDiff(input.events, taskId) === undefined
      ? {}
      : { diff: taskDiff(input.events, taskId) }),
  }
}

export function projectDashboardState(
  input: DashboardProjectionInput
): DashboardProjection {
  const state: DashboardRunState = {
    ...input.domain,
    stage: input.boundary.stage,
    createdAt: input.metadata.createdAt,
    updatedAt: input.metadata.updatedAt,
    ...(input.boundary.pendingHumanAction === undefined
      ? {}
      : { pendingHumanAction: input.boundary.pendingHumanAction }),
  }
  const nowMs = timestampMs(input.now ?? input.metadata.updatedAt, 'now')
  const terminal = ['completed', 'failed'].includes(state.stage)
  if (terminal && input.completedAt === undefined) {
    throw new Error('Terminal epics require completedAt.')
  }
  if (!terminal && input.completedAt !== undefined) {
    throw new Error('Only terminal epics may have completedAt.')
  }

  const completedAt = input.completedAt
  if (completedAt !== undefined) {
    timestampMs(completedAt, 'completedAt')
  }
  const tasks = state.tasks ?? []
  const criteriaTotal = tasks.reduce(
    (total, task) => total + task.acceptanceCriteria.length,
    0
  )
  const completedTasks = completedTaskCount(state, tasks)
  const criteriaCompleted = tasks
    .slice(0, completedTasks)
    .reduce((total, task) => total + task.acceptanceCriteria.length, 0)
  const taskProgress = progress(completedTasks, tasks.length)
  const epic: EpicDashboardState = {
    id: state.epicId,
    runDirectory: join(
      state.repositoryRoot,
      '.pi',
      'epics',
      'runs',
      state.epicId
    ),
    name: state.epic,
    status: dashboardStatus(state),
    startedAt: state.createdAt,
    ...(completedAt === undefined ? {} : { completedAt }),
    agentTimeMs: agentTimeMs(input.events, input.activeAgentRuns ?? [], nowMs),
    tasks: taskProgress,
    criteria: progress(criteriaCompleted, criteriaTotal),
    tokens: tokenUsage(input.events),
  }

  return {
    epic,
    pipeline: projectPipelineState(
      input.events,
      input.activeAgentRuns ?? [],
      input.agentProfiles,
      nowMs
    ),
    actionRequired: actionRequired(
      state,
      input.activeOperation === true,
      input.boundary.task?.failureReason ?? input.boundary.failureDiagnostics?.reason,
      input.boundary.task?.state,
      input.boundary.recoveryDiagnostics,
      input.verificationRecord
    ),
    currentTask: currentTask(input, state, tasks, nowMs),
  }
}
