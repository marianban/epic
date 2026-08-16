import { appendEvent, loadEpicEvents } from './persistence.ts'
import type { ActiveAgentRun } from './agent-activity.ts'
import type { EpicEvent, EpicRunIdentity } from './types.ts'

export const INTERRUPTED_AGENT_FAILURE_REASON =
  'Agent invocation was interrupted before completion.'

interface UnfinishedAgentStart {
  readonly event: EpicEvent
  readonly timestampMs: number
  readonly role: string
  readonly action: string
  readonly taskId?: string
  readonly invocationId?: string
}

function eventString(
  event: EpicEvent,
  field: string
): string | undefined {
  const value = event.payload[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Event ${event.id} has an invalid ${field}.`)
  }
  return value
}

function eventTimestampMs(event: EpicEvent): number {
  const timestampMs = Date.parse(event.timestamp)
  if (Number.isNaN(timestampMs)) {
    throw new Error(`Event ${event.id} has an invalid timestamp.`)
  }
  return timestampMs
}

function lifecycleKey(start: UnfinishedAgentStart): string {
  return JSON.stringify([start.role, start.action, start.taskId ?? null])
}

function sameInvocation(
  start: UnfinishedAgentStart,
  finish: EpicEvent
): boolean {
  const finishInvocationId = eventString(finish, 'invocationId')
  if (start.invocationId !== undefined || finishInvocationId !== undefined) {
    return (
      start.invocationId !== undefined &&
      start.invocationId === finishInvocationId
    )
  }
  return (
    start.role === eventString(finish, 'role') &&
    start.action === eventString(finish, 'action') &&
    start.taskId === eventString(finish, 'taskId')
  )
}

function unfinishedStarts(
  events: readonly EpicEvent[]
): readonly UnfinishedAgentStart[] {
  const open: UnfinishedAgentStart[] = []
  const seenInvocationIds = new Set<string>()
  for (const event of events) {
    if (event.type === 'agent_started') {
      const role = eventString(event, 'role')
      const action = eventString(event, 'action')
      if (role === undefined || action === undefined) {
        throw new Error(`Event ${event.id} is missing agent identity.`)
      }
      const taskId = eventString(event, 'taskId')
      const invocationId = eventString(event, 'invocationId')
      if (
        invocationId !== undefined &&
        seenInvocationIds.has(invocationId)
      ) {
        throw new Error(
          `Event ${event.id} starts duplicate invocation ${invocationId}.`
        )
      }
      if (invocationId !== undefined) seenInvocationIds.add(invocationId)
      open.push({
        event,
        timestampMs: eventTimestampMs(event),
        role,
        action,
        ...(taskId === undefined ? {} : { taskId }),
        ...(invocationId === undefined ? {} : { invocationId }),
      })
      continue
    }
    if (event.type !== 'agent_finished') continue

    const finishTimestampMs = eventTimestampMs(event)
    let index = -1
    for (let candidate = open.length - 1; candidate >= 0; candidate -= 1) {
      const start = open[candidate]
      if (start !== undefined && sameInvocation(start, event)) {
        index = candidate
        break
      }
    }
    if (index === -1) {
      throw new Error(
        `Event ${event.id} finished without a matching agent start.`
      )
    }
    const start = open[index]
    if (start === undefined) throw new Error(`Event ${event.id} has invalid lifecycle state.`)
    if (finishTimestampMs < start.timestampMs) {
      throw new Error(`Event ${event.id} ends before its agent starts.`)
    }
    open.splice(index, 1)
  }
  return open
}

function isLive(
  start: UnfinishedAgentStart,
  activeRuns: readonly ActiveAgentRun[]
): boolean {
  return activeRuns.some((run) =>
    start.invocationId !== undefined
      ? run.invocationId === start.invocationId
      : run.role === start.role &&
        run.action === start.action &&
        run.taskId === start.taskId
  )
}

function latestByLifecycle(
  starts: readonly UnfinishedAgentStart[]
): readonly UnfinishedAgentStart[] {
  const latest = new Map<string, UnfinishedAgentStart>()
  for (const start of starts) {
    latest.set(lifecycleKey(start), start)
  }
  return [...latest.values()]
}

function recoveryPayload(
  start: UnfinishedAgentStart,
  nowMs: number
): Record<string, unknown> {
  const durationMs = nowMs - start.timestampMs
  if (durationMs < 0) {
    throw new Error(
      `Cannot recover agent ${start.invocationId ?? lifecycleKey(start)} before it started.`
    )
  }
  const payload: Record<string, unknown> = {
    role: start.role,
    action: start.action,
    exitCode: 1,
    failureReason: INTERRUPTED_AGENT_FAILURE_REASON,
    durationMs,
  }
  if (start.invocationId !== undefined) payload.invocationId = start.invocationId
  if (start.taskId !== undefined) payload.taskId = start.taskId
  for (const field of ['provider', 'model', 'thinking']) {
    const value = start.event.payload[field]
    if (value !== undefined) payload[field] = value
  }
  return payload
}

/** Persist terminal telemetry for agent calls abandoned by a crashed/interrupted host. */
export async function recoverInterruptedAgentRuns(
  state: EpicRunIdentity,
  timestamp: string,
  nowMs: number,
  activeRuns: readonly ActiveAgentRun[]
): Promise<number> {
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`Agent recovery timestamp is invalid: ${timestamp}`)
  }
  if (!Number.isInteger(nowMs) || nowMs < 0) {
    throw new Error(`Agent recovery time must be a non-negative integer: ${nowMs}`)
  }
  const events = await loadEpicEvents(state)
  const candidates = latestByLifecycle(
    unfinishedStarts(events).filter((start) => !isLive(start, activeRuns))
  )
  for (const start of candidates) {
    await appendEvent(
      state,
      start.event.stage,
      timestamp,
      'agent_finished',
      recoveryPayload(start, nowMs)
    )
  }
  return candidates.length
}
