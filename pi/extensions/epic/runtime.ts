import { recoverAcceptancePlanning } from './acceptance-planning-recovery.ts'
import { parseEpicDomainState } from './domain-validation.ts'
import {
  VerificationStore,
  taskVerificationPath,
} from './verification-store.ts'
import { finalizeReviewReport } from './verification-report.ts'
import { EPIC_MACHINE_VERSION, EPIC_SCHEMA_VERSION } from './persistence-version.ts'
import { saveState } from './persistence.ts'
import { randomUUID } from 'node:crypto'
import {
  createActor,
  type Actor,
  type InspectionEvent,
  type Observer,
  type SnapshotFrom,
} from 'xstate'
import { createWebSocketInspector } from '@statelyai/inspect'
import { createInspectorServer } from '@statelyai/inspect/server'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import {
  createEpicMachine,
  type EpicMachineEvent,
} from './machines/epic-machine.ts'
import { runAgentActor } from './machines/actors.ts'
import { createEpicServices } from './services.ts'
import { projectActorSystemSnapshot } from './machines/actor-system-projection.ts'
import {
  liveTaskChild,
  type LiveTaskChild,
} from './machines/actor-system-projection.ts'
import type {
  EpicBoundaryView,
  EpicClock,
  ResolvedEpicConfiguration,
  EpicDomainState,
  EpicRunMetadata,
  EpicTimer,
  PersistedEpicEnvelope,
} from './types.ts'

type EpicActor = Actor<ReturnType<typeof createEpicMachine>>
interface EpicInspector {
  inspect: Observer<InspectionEvent>
}
const inspectors = new Map<number, EpicInspector>()

function createEpicInspector(
  config: ResolvedEpicConfiguration['inspector']
): EpicInspector | undefined {
  const enabled = process.env.PI_EPIC_INSPECTOR === '1' || config.enabled
  if (!enabled || process.env.PI_EPIC_INSPECTOR === '0') return undefined
  const port = Number(process.env.PI_EPIC_INSPECTOR_PORT ?? config.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Epic inspector port must be a valid TCP port.')
  const existing = inspectors.get(port)
  if (existing) return existing
  createInspectorServer({
    port,
    autoOpen:
      process.env.PI_EPIC_INSPECTOR_AUTO_OPEN === '1' ||
      (process.env.PI_EPIC_INSPECTOR_AUTO_OPEN !== '0' && config.autoOpen),
  })
  const result = {
    inspect: createWebSocketInspector({
      url: `ws://localhost:${port}`,
      sanitizeContext: () => ({}),
    }).inspect,
  }
  inspectors.set(port, result)
  return result
}

export async function createEpicRuntime(
  domain: EpicDomainState,
  metadata: EpicRunMetadata,
  ctx: ExtensionContext,
  clock: EpicClock,
  timer: EpicTimer,
  configuration: ResolvedEpicConfiguration,
  snapshot?: unknown
): Promise<EpicRuntime> {
  let recovered = false
  if (snapshot && typeof snapshot === 'object') {
    const persisted = structuredClone(snapshot) as {
      value: unknown
      context: { state: EpicDomainState }
      children?: Record<
        string,
        {
          snapshot: {
            value: unknown
            context: { domain: EpicDomainState }
            children?: unknown
          }
        }
      >
    }
    const child = persisted.children?.['task-execution']?.snapshot
    if (child && ['planningAcceptance', 'replanningAcceptance'].includes(String(child.value))) {
      await recoverAcceptancePlanning(child, clock)
      persisted.context.state = child.context.domain
      snapshot = persisted
      recovered = true
    } else if (child && !['acceptancePlanningFailed', 'acceptanceReplanningFailed'].includes(String(child.value))) {
      const store = new VerificationStore(taskVerificationPath(domain), clock)
      let record
      try {
        record = await store.read()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (
        record &&
        (!record.report ||
          !['awaitingReview', 'done'].includes(String(child.value)) ||
          (record.startedAt !== undefined && record.pausedAt === undefined))
      ) {
        child.value = 'awaitingReview'
        child.children = {}
        const latest = record.cycles.at(-1)
        const state = record.state ?? latest?.state ?? child.context.domain
        const identity = latest?.identity ?? randomUUID()
        const reason =
          'Task interrupted. Completed artifacts and charged invocations are retained; explicit resume verifies without repeating an interrupted repair.'
        if (latest?.identity === identity) latest.problems.push({ stage: 'interruption', obligationIds: [], message: reason })
        else
          record.cycles.push({
            id: randomUUID(),
            identity,
            attempt: record.cycles.length + 1,
            kind: 'initial_full', completed: false,
            candidateRevision: record.invocations.filter(i => i.kind === 'repair').length,
            evidence: [],
            evidenceReviews: [],
            problems: [{ stage: 'interruption', obligationIds: [], message: reason }],
            artifacts: [],
            state,
            plan: record.plan,
          })
        child.context.domain = await finalizeReviewReport(
          state,
          record,
          identity,
          store
        )
        persisted.context.state = child.context.domain
        snapshot = persisted
        recovered = true
      }
    }
  }
  const machine = createEpicMachine(
    createEpicServices(
      ctx,
      () => {
        if (!runtime) throw new Error('Epic boundary is not bound.')
        return runtime.boundary()
      },
      clock,
      configuration,
      { runAgentActor, timer }
    )
  )
  const actor = snapshot
    ? createActor(machine, {
        snapshot: snapshot as SnapshotFrom<typeof machine>,
        input: { state: domain },
        inspect: createEpicInspector(configuration.inspector)?.inspect,
      })
    : createActor(machine, {
        input: { state: domain },
        inspect: createEpicInspector(configuration.inspector)?.inspect,
      })
  const runtime = new EpicRuntime(actor, domain, metadata, timer)
  actor.start()
  if (recovered)
    await saveState(runtime.domain(), runtime.envelope(clock.now()))
  return runtime
}

function activeChild(actor: EpicActor): LiveTaskChild | undefined {
  return liveTaskChild(actor.getSnapshot())
}
function forwarded(event: EpicMachineEvent, hasTaskActor: boolean): boolean {
  return (
    [
      'TASK.APPROVE',
      'TASK.REVIEW',
      'TASK.REVISE',
      'TASK.DECIDE',
      'TASK.CANCEL',
    ].includes(event.type) ||
    (event.type === 'EPIC.RESUME' && hasTaskActor)
  )
}

export class EpicRuntime {
  private readonly actor: EpicActor
  private readonly domainState: EpicDomainState
  private readonly metadataState: EpicRunMetadata
  private readonly timer: EpicTimer
  constructor(
    actor: EpicActor,
    domainState: EpicDomainState,
    metadataState: EpicRunMetadata,
    timer: EpicTimer
  ) {
    this.actor = actor
    this.domainState = domainState
    this.metadataState = metadataState
    this.timer = timer
  }
  boundary(): EpicBoundaryView {
    return projectActorSystemSnapshot(this.actor.getSnapshot())
  }
  domain(): EpicDomainState {
    const child = activeChild(this.actor)?.getSnapshot().context?.domain
    return child
      ? parseEpicDomainState(child, 'live task domain')
      : (this.actor.getSnapshot().context as { state: EpicDomainState }).state
  }
  persistedSnapshot(): ReturnType<EpicActor['getPersistedSnapshot']> {
    return this.actor.getPersistedSnapshot()
  }
  // fallow-ignore-next-line unused-class-member -- consumed by epicStatus().
  tags(): ReadonlySet<string> {
    return this.actor.getSnapshot().tags
  }
  // fallow-ignore-next-line unused-class-member -- consumed by epicStatus().
  value(): unknown {
    return this.actor.getSnapshot().value
  }

  dispatchAndSettle(
    event: EpicMachineEvent,
    timeoutMs: number | undefined
  ): Promise<EpicBoundaryView> {
    if (
      timeoutMs !== undefined &&
      (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    )
      throw new Error('Epic dispatch timeout must be a positive number.')
    this.boundary()
    const parent = this.actor
    if (!parent.getSnapshot().can(event))
      throw new Error(
        `Epic event ${event.type} is not available in stage ${this.boundary().stage}.`
      )
    const child = activeChild(parent)
    const taskForwarded = forwarded(event, child !== undefined)
    const processor = taskForwarded ? child : parent
    if (
      [
        'TASK.APPROVE',
        'TASK.REVIEW',
        'TASK.REVISE',
        'TASK.DECIDE',
        'TASK.CANCEL',
      ].includes(event.type) &&
      !child
    )
      throw new Error('Task event requires an active task-execution actor.')
    if (taskForwarded && event.type !== 'EPIC.RESUME') {
      const taskActor = child
      if (!taskActor || !taskActor.getSnapshot().can(event))
        throw new Error(
          `Task event ${event.type} is not available in stage ${this.boundary().stage}.`
        )
    }
    return new Promise((resolve, reject) => {
      let acknowledged = false
      let settled = false
      let sent = false
      const timer =
        timeoutMs === undefined
          ? undefined
          : this.timer.setTimeout(() => {
              if (!settled) {
                settled = true
                cleanup()
                reject(
                  new Error(
                    `Epic event ${event.type} did not settle before timeout.`
                  )
                )
              }
            }, timeoutMs)
      const cleanup = () => {
        if (timer !== undefined) this.timer.clearTimeout(timer)
        parentSubscription.unsubscribe()
        childSubscription?.unsubscribe()
      }
      const evaluate = () => {
        if (!acknowledged || settled) return
        try {
          const view = this.boundary()
          if (view.wait !== 'active') {
            settled = true
            cleanup()
            resolve(view)
          }
        } catch (error) {
          settled = true
          cleanup()
          reject(error)
        }
      }
      const observer = (source: unknown) => ({
        next: () => {
          if (sent && source === processor) acknowledged = true
          evaluate()
        },
        error: (error: unknown) => {
          if (!settled) {
            settled = true
            cleanup()
            reject(error)
          }
        },
      })
      const parentSubscription = parent.subscribe(observer(parent))
      const childSubscription = child?.subscribe(observer(child))
      try {
        sent = true
        parent.send(event)
      } catch (error) {
        settled = true
        cleanup()
        reject(error)
      }
    })
  }
  envelope(now: string): PersistedEpicEnvelope {
    const snapshot = this.persistedSnapshot()
    if ('context' in snapshot)
      (snapshot.context as { state: EpicDomainState }).state = this.domain()
    return {
      schemaVersion: EPIC_SCHEMA_VERSION,
      machineVersion: EPIC_MACHINE_VERSION,
      epicId: this.metadataState.epicId,
      createdAt: this.metadataState.createdAt,
      updatedAt: now,
      snapshot,
    }
  }
  // fallow-ignore-next-line unused-class-member -- consumed by epic operation cleanup.
  stop(): void {
    this.actor.stop()
  }
}
