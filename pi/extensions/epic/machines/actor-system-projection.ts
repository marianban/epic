import type {
  EpicBoundaryView,
  EpicStage,
  PendingHumanAction,
  RepairAttempts,
} from '../types.ts'

interface Snapshot {
  value: unknown
  children?: Record<string, unknown>
}
export interface TaskChildSnapshot {
  value: unknown
  context?: {
    repairs?: unknown
    domain?: unknown
    failureReason?: unknown
  }
}

const parentStages: Record<string, EpicStage> = {
  idle: 'idle',
  classifying: 'classifying',
  decomposingTasks: 'decomposing_tasks',
  checkpointing: 'final_verification',
  escalating: 'escalating',
  recovering: 'recovering',
  finalVerification: 'final_verification',
}
const planningStages: Record<string, EpicStage> = {
  scouting: 'scouting',
  generating: 'planning',
  awaitingReview: 'awaiting_plan_review',
  revising: 'revising_plan',
  awaitingApproval: 'awaiting_plan_approval',
  approving: 'planning',
}
const prerequisiteStages: Record<string, EpicStage> = {
  checking: 'checking_prerequisites',
  awaitingApproval: 'awaiting_prerequisite_approval',
  preparing: 'preparing_prerequisites',
}
const childStages: Record<string, EpicStage> = {
  awaitingApproval: 'awaiting_task_approval',
  revisingTask: 'revising_task',
  implementing: 'implementing',
  fastChecks: 'running_fast_checks',
  repairingFast: 'repairing_fast_checks',
  repairingFastInvoke: 'repairing_fast_checks',
  fullChecks: 'running_full_checks',
  routeAfterFullChecks: 'running_full_checks',
  'browserVerification.startingDevServer': 'starting_dev_server',
  'browserVerification.runningSmoke': 'running_browser_smoke',
  'browserVerification.recordingServerFailure': 'running_browser_smoke',
  repairingBrowserSmoke: 'repairing_browser_smoke',
  repairingBrowserSmokeInvoke: 'repairing_browser_smoke',
  repairingFull: 'repairing_full_checks',
  repairingFullInvoke: 'repairing_full_checks',
  reviewing: 'reviewing',
  repairingReview: 'repairing_review',
  repairingReviewInvoke: 'repairing_review',
  awaitingReview: 'awaiting_task_review',
  escalating: 'escalating',
  done: 'final_verification',
  failed: 'failed',
}
const humanActions: Partial<Record<EpicStage, PendingHumanAction>> = {
  awaiting_plan_review: 'approve_plan',
  awaiting_plan_approval: 'approve_plan',
  awaiting_prerequisite_approval: 'approve_prerequisites',
  awaiting_task_approval: 'approve_task',
  awaiting_task_review: 'review_task',
  escalating: 'resolve_escalation',
  recovering: 'approve_recovery',
}

function boundary(
  stage: EpicStage,
  task?: EpicBoundaryView['task'],
  failureDiagnostics?: EpicBoundaryView['failureDiagnostics'],
  recoveryDiagnostics?: EpicBoundaryView['recoveryDiagnostics']
): EpicBoundaryView {
  const terminal = stage === 'completed' || stage === 'failed'
  const pendingHumanAction = humanActions[stage]
  return {
    stage,
    wait: terminal
      ? 'terminal'
      : pendingHumanAction
        ? 'awaiting-human'
        : 'active',
    ...(pendingHumanAction ? { pendingHumanAction } : {}),
    ...(task ? { task } : {}),
    ...(failureDiagnostics ? { failureDiagnostics } : {}),
    ...(recoveryDiagnostics ? { recoveryDiagnostics } : {}),
  }
}

export function parseRepairAttempts(
  value: unknown,
  source = 'task actor repairs'
): RepairAttempts {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(
      `${source} must be an object with fast, full, and semantic counters.`
    )
  const repairs = value as Record<string, unknown>
  for (const key of ['fast', 'full', 'semantic']) {
    if (!Number.isInteger(repairs[key]) || (repairs[key] as number) < 0)
      throw new Error(`${source}.${key} must be a non-negative integer.`)
  }
  if (
    Object.keys(repairs).some(
      (key) => !['fast', 'full', 'semantic'].includes(key)
    )
  )
    throw new Error(`${source} contains unsupported counter fields.`)
  return {
    fast: repairs.fast as number,
    full: repairs.full as number,
    semantic: repairs.semantic as number,
  }
}

function projectChild(snapshot: TaskChildSnapshot): EpicBoundaryView {
  const key = stateValueKey(snapshot.value)
  const stage = childStages[key]
  if (!stage) throw new Error(`Unknown task actor state: ${key}.`)
  if (!snapshot.context || !('repairs' in snapshot.context))
    throw new Error('task actor context is missing repair attempts.')
  const repairs = parseRepairAttempts(snapshot.context.repairs)
  return boundary(
    stage,
    { state: key, repairs },
    taskFailureDiagnostics(snapshot, stage, repairs)
  )
}

function stateValueKey(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('task actor state value is malformed.')
  const entries = Object.entries(value)
  if (entries.length !== 1)
    throw new Error('task actor state value must contain one active branch.')
  const entry = entries[0]
  if (!entry) throw new Error('task actor state value is empty.')
  return `${entry[0]}.${stateValueKey(entry[1])}`
}

function taskFailureDiagnostics(
  snapshot: TaskChildSnapshot,
  stage: EpicStage,
  repairs: RepairAttempts
): EpicBoundaryView['failureDiagnostics'] {
  if (stage !== 'escalating') return undefined
  const context = snapshot.context
  if (!context) throw new Error('Task actor escalation context is missing.')

  const domain = context.domain
  const domainFailureReason =
    domain && typeof domain === 'object' && !Array.isArray(domain)
      ? (domain as { failureReason?: unknown }).failureReason
      : undefined
  const reason = domainFailureReason ?? context.failureReason
  if (typeof reason !== 'string' || reason.length === 0)
    throw new Error('Task actor escalation requires a failure reason.')
  return { reason, repairs }
}

function assertChildSnapshot(value: unknown): TaskChildSnapshot {
  if (!value || typeof value !== 'object' || !('value' in value))
    throw new Error('task-execution child snapshot is malformed.')
  return value as TaskChildSnapshot
}
export interface LiveTaskChild {
  getSnapshot(): TaskChildSnapshot & { can(event: unknown): boolean }
  subscribe(observer: {
    next(value: TaskChildSnapshot): void
    error?(error: unknown): void
  }): { unsubscribe(): void }
}
export function liveTaskChild(parent: Snapshot): LiveTaskChild | undefined {
  const child = parent.children?.['task-execution']
  if (child === undefined) return undefined
  if (
    !child ||
    typeof child !== 'object' ||
    !('getSnapshot' in child) ||
    typeof (child as { getSnapshot?: unknown }).getSnapshot !== 'function'
  )
    throw new Error('live task-execution child is malformed.')
  const live = child as LiveTaskChild
  assertChildSnapshot(live.getSnapshot())
  return live
}
function childSnapshot(parent: Snapshot): TaskChildSnapshot {
  const child = parent.children?.['task-execution'] as
    { getSnapshot?: () => unknown; snapshot?: unknown } | undefined
  if (!child)
    throw new Error('taskExecution requires task-execution child snapshot.')
  return child.getSnapshot
    ? assertChildSnapshot(child.getSnapshot())
    : assertChildSnapshot(child.snapshot)
}

export function projectActorSystemSnapshot(
  snapshot: Snapshot
): EpicBoundaryView {
  const value = snapshot.value
  if (value === 'taskExecution') return projectChild(childSnapshot(snapshot))
  if (snapshot.children?.['task-execution'] !== undefined)
    throw new Error('task-execution child exists outside taskExecution.')
  if (typeof value === 'string') {
    const stage = parentStages[value]
    if (!stage) throw new Error(`Unknown epic actor state: ${value}.`)
    return boundary(stage, undefined, failureDiagnostics(snapshot, stage))
  }
  if (!value || typeof value !== 'object')
    throw new Error('Epic snapshot value is malformed.')
  const record = value as Record<string, unknown>
  if (typeof record.planning === 'string') {
    const stage = planningStages[record.planning]
    if (!stage) throw new Error(`Unknown planning state: ${record.planning}.`)
    return boundary(stage)
  }
  if (typeof record.prerequisites === 'string') {
    const stage = prerequisiteStages[record.prerequisites]
    if (!stage)
      throw new Error(`Unknown prerequisites state: ${record.prerequisites}.`)
    return boundary(stage)
  }
  if (typeof record.recovering === 'string') {
    const context = (snapshot as { context?: { recovery?: unknown } }).context
    const value = context?.recovery
    if (!value || typeof value !== 'object')
      throw new Error('Recovery state requires diagnostics.')
    return boundary('recovering', undefined, undefined, value as EpicBoundaryView['recoveryDiagnostics'])
  }
  if (
    typeof record.terminal === 'string' &&
    (record.terminal === 'completed' || record.terminal === 'failed')
  )
    return boundary(record.terminal)
  throw new Error(`Unknown epic actor state: ${JSON.stringify(value)}.`)
}

function failureDiagnostics(
  snapshot: Snapshot,
  stage: EpicStage
): EpicBoundaryView['failureDiagnostics'] {
  if (stage !== 'escalating') return undefined
  const context = (snapshot as { context?: unknown }).context
  if (!context || typeof context !== 'object') return undefined
  const diagnostics = (context as { failureDiagnostics?: unknown })
    .failureDiagnostics
  if (diagnostics === undefined) return undefined
  if (!diagnostics || typeof diagnostics !== 'object')
    throw new Error('Epic failure diagnostics are malformed.')
  const record = diagnostics as { reason?: unknown; repairs?: unknown }
  if (typeof record.reason !== 'string' || !record.reason)
    throw new Error('Epic failure diagnostics require a reason.')
  return {
    reason: record.reason,
    repairs: parseRepairAttempts(
      record.repairs,
      'epic failure diagnostics.repairs'
    ),
  }
}
