import type {
  AgentProfile,
  EpicEvent,
} from '../types.ts'
import {
  CANONICAL_AGENT_ROLE_ORDER,
  compareAgentRoles,
} from '../agent-profiles.ts'
import { normalizeTokenUsage, aggregateTokenUsage } from './token-usage.ts'
import type {
  ActiveAgentRun,
  PipelineAgentDashboardState,
  PipelineAgentStatus,
  PipelineDashboardState,
  PipelineModelDashboardState,
  TokenUsage,
} from './types.ts'

type Thinking = NonNullable<AgentProfile['thinking']>

const THINKING_ORDER: readonly Thinking[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

interface Metadata {
  readonly provider?: string
  readonly model?: string
  readonly thinking?: Thinking
}


interface Invocation {
  readonly key: string
  readonly invocationId?: string
  readonly role: string
  readonly action: string
  readonly taskId?: string
  readonly startedAtMs: number
  readonly startOrder: number
  readonly startMetadata: Metadata
  finishAtMs?: number
  finishOrder?: number
  finishMetadata?: Metadata
  exitCode?: number
  failureReason?: string
  usage?: TokenUsage
  active?: ActiveAgentRun
}

function fail(eventOrInvocation: string, message: string): never {
  throw new Error(`Pipeline telemetry ${eventOrInvocation}: ${message}`)
}

function timestampMs(event: EpicEvent): number {
  const value = Date.parse(event.timestamp)
  if (Number.isNaN(value)) fail(`event ${event.id}`, 'has an invalid timestamp.')
  return value
}

function requiredString(
  event: EpicEvent,
  field: string,
  value: unknown = event.payload[field]
): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`event ${event.id}`, `has an invalid ${field}.`)
  }
  return value
}

function optionalString(
  event: EpicEvent,
  field: string,
  value: unknown = event.payload[field]
): string | undefined {
  if (value === undefined) return undefined
  return requiredString(event, field, value)
}

function optionalThinking(event: EpicEvent): Thinking | undefined {
  const value = event.payload.thinking
  if (value === undefined) return undefined
  if (!THINKING_ORDER.includes(value as Thinking)) {
    fail(`event ${event.id}`, 'has an invalid thinking level.')
  }
  return value as Thinking
}

function eventMetadata(event: EpicEvent): Metadata {
  return {
    ...(optionalString(event, 'provider') === undefined
      ? {}
      : { provider: optionalString(event, 'provider') }),
    ...(optionalString(event, 'model') === undefined
      ? {}
      : { model: optionalString(event, 'model') }),
    ...(optionalThinking(event) === undefined
      ? {}
      : { thinking: optionalThinking(event) }),
  }
}

function taskId(event: EpicEvent): string | undefined {
  return optionalString(event, 'taskId')
}

function invocationId(event: EpicEvent): string | undefined {
  return optionalString(event, 'invocationId')
}

function nonNegativeInteger(
  eventOrInvocation: string,
  field: string,
  value: unknown
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail(eventOrInvocation, `has an invalid ${field}.`)
  }
  return value
}

function optionalNonNegativeInteger(
  event: EpicEvent,
  field: string
): number | undefined {
  const value = event.payload[field]
  return value === undefined
    ? undefined
    : nonNegativeInteger(`event ${event.id}`, field, value)
}


function invocationKey(role: string, action: string): string {
  return `${role}\u0000${action}`
}

function lifecycleEvents(
  events: readonly EpicEvent[]
): readonly {
  event: EpicEvent
  timestampMs: number
  journalOrder: number
  eventOrder: number
}[] {
  return events
    .map((event, journalOrder) => ({ event, journalOrder }))
    .filter(
      ({ event }) =>
        event.type === 'agent_started' || event.type === 'agent_finished'
    )
    .map(({ event, journalOrder }) => ({
      event,
      timestampMs: timestampMs(event),
      journalOrder,
    }))
    .sort(
      (left, right) =>
        left.timestampMs - right.timestampMs ||
        left.journalOrder - right.journalOrder
    )
    .map((entry, eventOrder) => ({ ...entry, eventOrder }))
}

function assertSameIdentity(
  event: EpicEvent,
  invocation: Invocation,
  id: string | undefined,
  role: string,
  action: string,
  task: string | undefined
): void {
  if (id !== invocation.invocationId) {
    fail(
      `event ${event.id}`,
      `has mismatched invocation identity for ${invocation.key}.`
    )
  }
  if (role !== invocation.role || action !== invocation.action) {
    fail(
      `event ${event.id}`,
      `does not match invocation ${invocation.invocationId ?? invocation.key}.`
    )
  }
  if (task !== invocation.taskId) {
    fail(
      `event ${event.id}`,
      `has a task identity mismatch for invocation ${invocation.invocationId ?? invocation.key}.`
    )
  }
}

function activeMetadata(run: ActiveAgentRun): Metadata {
  return {
    ...(run.provider === undefined ? {} : { provider: run.provider }),
    ...(run.model === undefined ? {} : { model: run.model }),
    ...(run.thinking === undefined ? {} : { thinking: run.thinking }),
  }
}

function validateActiveRun(run: ActiveAgentRun, nowMs: number): void {
  if (typeof run.invocationId !== 'string' || run.invocationId.length === 0) {
    fail('active invocation', 'has an invalid invocation ID.')
  }
  if (typeof run.role !== 'string' || run.role.length === 0) {
    fail(`active invocation ${run.invocationId}`, 'has an invalid role.')
  }
  if (typeof run.action !== 'string' || run.action.length === 0) {
    fail(`active invocation ${run.invocationId}`, 'has an invalid action.')
  }
  if (
    (run.provider !== undefined && typeof run.provider !== 'string') ||
    (run.model !== undefined && typeof run.model !== 'string') ||
    (run.taskId !== undefined && typeof run.taskId !== 'string')
  ) {
    fail(`active invocation ${run.invocationId}`, 'has invalid identity metadata.')
  }
  if (run.thinking !== undefined && !THINKING_ORDER.includes(run.thinking)) {
    fail(`active invocation ${run.invocationId}`, 'has an invalid thinking level.')
  }
  nonNegativeInteger(`active invocation ${run.invocationId}`, 'startedAtMs', run.startedAtMs)
  if (run.startedAtMs > nowMs) {
    fail(`active invocation ${run.invocationId}`, 'starts after now.')
  }
}

function normalizeInvocations(
  events: readonly EpicEvent[],
  activeRuns: readonly ActiveAgentRun[],
  nowMs: number
): readonly Invocation[] {
  for (const run of activeRuns) validateActiveRun(run, nowMs)

  const isLive = (invocation: Invocation): boolean =>
    activeRuns.some(
      (run) =>
        run.invocationId === invocation.invocationId ||
        (invocation.invocationId === undefined &&
          run.role === invocation.role &&
          run.action === invocation.action &&
          run.taskId === invocation.taskId)
    )

  const abandon = (
    invocation: Invocation,
    finishAtMs: number,
    finishOrder: number
  ): void => {
    invocation.finishAtMs = finishAtMs
    invocation.finishOrder = finishOrder
    invocation.failureReason =
      'Invocation has no live activity record; it may have been interrupted.'
    open.delete(invocation)
    const roleAction = invocationKey(invocation.role, invocation.action)
    if (pendingByRoleAction.get(roleAction) === invocation) {
      pendingByRoleAction.delete(roleAction)
    }
  }

  const byId = new Map<string, Invocation>()
  const pendingByRoleAction = new Map<string, Invocation>()
  const open = new Set<Invocation>()
  const invocations: Invocation[] = []
  for (const { event, timestampMs: startedAtMs, eventOrder } of lifecycleEvents(events)) {
    const role = requiredString(event, 'role')
    const action = requiredString(event, 'action')
    const id = invocationId(event)
    const key = id ?? invocationKey(role, action)
    const task = taskId(event)
    if (event.type === 'agent_started') {
      if (id !== undefined && byId.has(id)) {
        fail(`event ${event.id}`, `starts duplicate invocation ${id}.`)
      }
      for (const previous of [...open]) {
        if (isLive(previous)) {
          fail(`event ${event.id}`, 'overlaps another invocation.')
        }
        abandon(previous, startedAtMs, eventOrder)
      }
      if (pendingByRoleAction.has(invocationKey(role, action))) {
        fail(`event ${event.id}`, 'overlaps another invocation.')
      }
      const invocation: Invocation = {
        key,
        ...(id === undefined ? {} : { invocationId: id }),
        role,
        action,
        ...(task === undefined ? {} : { taskId: task }),
        startedAtMs,
        startOrder: eventOrder,
        startMetadata: eventMetadata(event),
      }
      invocations.push(invocation)
      if (id !== undefined) byId.set(id, invocation)
      pendingByRoleAction.set(invocationKey(role, action), invocation)
      open.add(invocation)
      continue
    }

    const roleAction = invocationKey(role, action)
    const candidate =
      id === undefined ? pendingByRoleAction.get(roleAction) : byId.get(id)
    if (candidate === undefined) {
      fail(`event ${event.id}`, 'finishes without a matching start.')
    }
    if (candidate.finishAtMs !== undefined || !open.has(candidate)) {
      fail(`event ${event.id}`, 'finishes an invocation that is not active.')
    }
    if (candidate.invocationId !== undefined && id === undefined) {
      fail(`event ${event.id}`, 'omits the invocation ID required by its start.')
    }
    if (candidate.invocationId === undefined && id !== undefined) {
      fail(`event ${event.id}`, 'introduces an invocation ID absent from its start.')
    }
    assertSameIdentity(event, candidate, id, role, action, task)
    const durationMs = optionalNonNegativeInteger(event, 'durationMs')
    if (startedAtMs < candidate.startedAtMs) {
      fail(`event ${event.id}`, 'finishes before it starts.')
    }
    const normalizedUsage = normalizeTokenUsage(event)
    candidate.finishAtMs = startedAtMs
    candidate.finishOrder = eventOrder
    candidate.finishMetadata = eventMetadata(event)
    candidate.exitCode = event.payload.exitCode === undefined
      ? undefined
      : nonNegativeInteger(`event ${event.id}`, 'exitCode', event.payload.exitCode)
    candidate.failureReason = optionalString(event, 'failureReason')
    candidate.usage = normalizedUsage
    if (durationMs !== undefined) candidate.finishAtMs = candidate.startedAtMs + durationMs
    open.delete(candidate)
    pendingByRoleAction.delete(roleAction)
  }

  const matchedActive = new Set<Invocation>()
  const activeIds = new Set<string>()
  for (const run of activeRuns) {
    if (activeIds.has(run.invocationId)) {
      fail(`active invocation ${run.invocationId}`, 'is duplicated.')
    }
    activeIds.add(run.invocationId)
    const candidate = byId.get(run.invocationId)
    if (candidate === undefined) {
      const legacy = pendingByRoleAction.get(invocationKey(run.role, run.action))
      if (legacy === undefined || legacy.invocationId !== undefined) {
        fail(`active invocation ${run.invocationId}`, 'has no matching start.')
      }
      assertSameIdentity(
        {
          id: run.invocationId,
          epicId: '',
          timestamp: new Date(run.startedAtMs).toISOString(),
          type: 'active',
          stage: 'idle',
          payload: {},
        },
        legacy,
        undefined,
        run.role,
        run.action,
        run.taskId
      )
      legacy.active = run
      matchedActive.add(legacy)
      continue
    }
    if (candidate.finishAtMs !== undefined) {
      fail(`active invocation ${run.invocationId}`, 'matches a finished invocation.')
    }
    if (candidate.role !== run.role || candidate.action !== run.action) {
      fail(`active invocation ${run.invocationId}`, 'has mismatched role/action.')
    }
    if (candidate.taskId !== run.taskId) {
      fail(`active invocation ${run.invocationId}`, 'has mismatched task identity.')
    }
    candidate.active = run
    matchedActive.add(candidate)
  }

  for (const invocation of open) {
    if (!matchedActive.has(invocation)) {
      abandon(invocation, nowMs, invocation.startOrder)
    }
  }

  const normalized = invocations.map((invocation) => {
    if (invocation.active === undefined) return invocation
    return {
      ...invocation,
      finishAtMs: nowMs,
    }
  })
  const intervals = normalized
    .map((invocation) => ({
      invocation,
      start: invocation.active?.startedAtMs ?? invocation.startedAtMs,
      end:
        invocation.active?.startedAtMs === undefined
          ? invocation.finishAtMs ?? invocation.startedAtMs
          : nowMs,
    }))
    .sort((left, right) => left.start - right.start || left.invocation.startOrder - right.invocation.startOrder)
  let previous: { start: number; end: number; invocation: Invocation } | undefined
  for (const interval of intervals) {
    if (previous !== undefined && interval.start < previous.end) {
      fail(
        `invocation ${interval.invocation.invocationId ?? interval.invocation.key}`,
        `overlaps invocation ${previous.invocation.invocationId ?? previous.invocation.key}.`
      )
    }
    if (previous === undefined || interval.end > previous.end) previous = interval
  }
  return normalized
}

function metadataValue<T extends string>(
  invocation: Invocation,
  field: keyof Metadata,
  profile: AgentProfile | undefined
): T | undefined {
  const active = invocation.active === undefined ? undefined : activeMetadata(invocation.active)
  const values = [
    active?.[field],
    invocation.finishMetadata?.[field],
    invocation.startMetadata[field],
    profile?.[field],
  ]
  return values.find((value): value is T => value !== undefined)
}

function invocationTokenUsage(invocations: readonly Invocation[]): TokenUsage | undefined {
  return aggregateTokenUsage(invocations
    .filter((invocation) => invocation.active === undefined && invocation.finishAtMs !== undefined)
    .map((invocation) => invocation.usage))
}

function invocationStatus(invocation: Invocation): PipelineAgentStatus {
  if (invocation.active !== undefined) return 'running'
  return invocation.exitCode !== undefined && invocation.exitCode !== 0 || invocation.failureReason !== undefined
    ? 'failed'
    : 'idle'
}

function latestFinished(invocations: readonly Invocation[]): Invocation | undefined {
  return invocations
    .filter((invocation) => invocation.finishAtMs !== undefined)
    .sort((left, right) => (left.finishOrder ?? 0) - (right.finishOrder ?? 0))
    .at(-1)
}

function statusFor(invocations: readonly Invocation[]): PipelineAgentStatus {
  if (invocations.some((invocation) => invocation.active !== undefined)) return 'running'
  const latest = latestFinished(invocations)
  return latest === undefined ? 'idle' : invocationStatus(latest)
}

function durationFor(invocation: Invocation): number {
  if (invocation.active !== undefined) {
    return invocation.active.startedAtMs <= (invocation.finishAtMs ?? 0)
      ? (invocation.finishAtMs ?? 0) - invocation.active.startedAtMs
      : 0
  }
  return Math.max(0, (invocation.finishAtMs ?? invocation.startedAtMs) - invocation.startedAtMs)
}

function groupId(provider: string | undefined, model: string | undefined): string {
  return JSON.stringify([provider ?? null, model ?? null])
}

function modelSortKey(model: ModelAccumulator): [number, string, string] {
  const firstRole = [...model.roles].sort(compareAgentRoles)[0] ?? ''
  const roleIndex = [...model.roles]
    .map((role) => {
      const canonical = CANONICAL_AGENT_ROLE_ORDER.indexOf(role as AgentProfile['role'])
      return canonical === -1 ? Number.MAX_SAFE_INTEGER : canonical
    })
    .sort((left, right) => left - right)[0] ?? Number.MAX_SAFE_INTEGER
  return [roleIndex, firstRole, `${model.provider ?? ''}\u0000${model.model ?? ''}`]
}

interface ModelAccumulator {
  readonly id: string
  readonly provider?: string
  readonly model?: string
  readonly roles: Set<string>
  readonly thinkingLevels: Set<Thinking>
  readonly invocations: Invocation[]
}

export function projectPipelineState(
  events: readonly EpicEvent[],
  activeAgentRuns: readonly ActiveAgentRun[],
  agentProfiles: readonly AgentProfile[],
  nowMs: number
): PipelineDashboardState {
  nonNegativeInteger('pipeline now', 'nowMs', nowMs)
  const profileByRole = new Map<string, AgentProfile>()
  for (const profile of agentProfiles) {
    if (profileByRole.has(profile.role)) fail('profiles', `duplicate role ${profile.role}.`)
    profileByRole.set(profile.role, profile)
  }
  const invocations = normalizeInvocations(events, activeAgentRuns, nowMs)
  const roleInvocations = new Map<string, Invocation[]>()
  for (const invocation of invocations) {
    const list = roleInvocations.get(invocation.role) ?? []
    list.push(invocation)
    roleInvocations.set(invocation.role, list)
  }
  const roles = [...new Set([...profileByRole.keys(), ...roleInvocations.keys()])].sort(compareAgentRoles)
  const agents: PipelineAgentDashboardState[] = roles.map((role) => {
    const roleRuns = roleInvocations.get(role) ?? []
    const profile = profileByRole.get(role)
    const latest = roleRuns.some((run) => run.active !== undefined)
      ? roleRuns.filter((run) => run.active !== undefined).at(-1)
      : latestFinished(roleRuns)
    const provider = latest === undefined
      ? profile?.provider
      : metadataValue<string>(latest, 'provider', profile)
    const model = latest === undefined
      ? profile?.model
      : metadataValue<string>(latest, 'model', profile)
    const thinking = latest === undefined
      ? profile?.thinking
      : metadataValue<Thinking>(latest, 'thinking', profile)
    return {
      role,
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
      ...(thinking === undefined ? {} : { thinking }),
      status: statusFor(roleRuns),
      runCount: roleRuns.length,
      agentTimeMs: roleRuns.reduce((total, run) => total + durationFor(run), 0),
      ...(invocationTokenUsage(roleRuns) === undefined ? {} : { tokens: invocationTokenUsage(roleRuns) }),
    }
  })

  const modelMap = new Map<string, ModelAccumulator>()
  const ensureModel = (provider: string | undefined, model: string | undefined): ModelAccumulator => {
    const id = groupId(provider, model)
    const existing = modelMap.get(id)
    if (existing !== undefined) return existing
    const created: ModelAccumulator = {
      id,
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
      roles: new Set(),
      thinkingLevels: new Set(),
      invocations: [],
    }
    modelMap.set(id, created)
    return created
  }
  for (const profile of agentProfiles) {
    const model = ensureModel(profile.provider, profile.model)
    model.roles.add(profile.role)
    if (profile.thinking !== undefined) model.thinkingLevels.add(profile.thinking)
  }
  for (const invocation of invocations) {
    const profile = profileByRole.get(invocation.role)
    const provider = metadataValue<string>(invocation, 'provider', profile)
    const modelId = metadataValue<string>(invocation, 'model', profile)
    const model = ensureModel(provider, modelId)
    model.roles.add(invocation.role)
    const thinking = metadataValue<Thinking>(invocation, 'thinking', profile)
    if (thinking !== undefined) model.thinkingLevels.add(thinking)
    model.invocations.push(invocation)
  }
  const models: PipelineModelDashboardState[] = [...modelMap.values()]
    .sort((left, right) => {
      const leftKey = modelSortKey(left)
      const rightKey = modelSortKey(right)
      return leftKey[0] - rightKey[0] || leftKey[1].localeCompare(rightKey[1]) || leftKey[2].localeCompare(rightKey[2])
    })
    .map((model) => {
      const thinkingLevels = THINKING_ORDER.filter((thinking) => model.thinkingLevels.has(thinking))
      return {
        id: model.id,
        ...(model.provider === undefined ? {} : { provider: model.provider }),
        ...(model.model === undefined ? {} : { model: model.model }),
        thinkingLevels,
        roles: [...model.roles].sort(compareAgentRoles),
        status: statusFor(model.invocations),
        runCount: model.invocations.length,
        agentTimeMs: model.invocations.reduce((total, invocation) => total + durationFor(invocation), 0),
        ...(invocationTokenUsage(model.invocations) === undefined ? {} : { tokens: invocationTokenUsage(model.invocations) }),
      }
    })
  return { agents, models }
}
