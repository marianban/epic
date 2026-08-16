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
import { liveTaskChild, type LiveTaskChild } from './machines/actor-system-projection.ts'
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
  const enabled =
    process.env.PI_EPIC_INSPECTOR === '1' || config.enabled
  if (!enabled || process.env.PI_EPIC_INSPECTOR === '0') return undefined
  const port = Number(
    process.env.PI_EPIC_INSPECTOR_PORT ?? config.port
  )
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Epic inspector port must be a valid TCP port.')
  const existing = inspectors.get(port)
  if (existing) return existing
  createInspectorServer({
    port,
    autoOpen:
      process.env.PI_EPIC_INSPECTOR_AUTO_OPEN === '1' ||
      (process.env.PI_EPIC_INSPECTOR_AUTO_OPEN !== '0' &&
        config.autoOpen),
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
  const machine = createEpicMachine(
    createEpicServices(
      ctx,
      () => {
        if (!runtime) throw new Error('Epic boundary is not bound.')
        return runtime.boundary()
      },
      clock,
      configuration,
      { runAgentActor }
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
  return runtime
}

function activeChild(actor: EpicActor): LiveTaskChild | undefined {
  return liveTaskChild(actor.getSnapshot())
}
function forwarded(event: EpicMachineEvent, hasTaskActor: boolean): boolean {
  return (
    ['TASK.APPROVE', 'TASK.REVIEW', 'TASK.REVISE'].includes(event.type) ||
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
    return (this.actor.getSnapshot().context as { state: EpicDomainState })
      .state
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
    timeoutMs: number
  ): Promise<EpicBoundaryView> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
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
      ['TASK.APPROVE', 'TASK.REVIEW', 'TASK.REVISE'].includes(event.type) &&
      !child
    )
      throw new Error('Task event requires an active task-execution actor.')
    if (taskForwarded && event.type !== 'EPIC.RESUME') {
      const taskActor = child
      if (
        !taskActor ||
        !taskActor.getSnapshot().can(event)
      )
        throw new Error(
          `Task event ${event.type} is not available in stage ${this.boundary().stage}.`
        )
    }
    return new Promise((resolve, reject) => {
      let acknowledged = false
      let settled = false
      let sent = false
      const timer = this.timer.setTimeout(() => {
        if (!settled) {
          settled = true
          cleanup()
          reject(
            new Error(`Epic event ${event.type} did not settle before timeout.`)
          )
        }
      }, timeoutMs)
      const cleanup = () => {
        this.timer.clearTimeout(timer)
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
  // fallow-ignore-next-line unused-class-member -- consumed by epic lifecycle persistence.
  envelope(now: string): PersistedEpicEnvelope {
    return {
      schemaVersion: 5,
      machineVersion: 8,
      epicId: this.metadataState.epicId,
      createdAt: this.metadataState.createdAt,
      updatedAt: now,
      snapshot: this.persistedSnapshot(),
    }
  }
  // fallow-ignore-next-line unused-class-member -- consumed by epic operation cleanup.
  stop(): void {
    this.actor.stop()
  }
}
