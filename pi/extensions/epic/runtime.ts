import {
  createActor,
  type Actor,
  type InspectionEvent,
  type Observer,
  type SnapshotFrom,
} from 'xstate'
import { createWebSocketInspector } from '@statelyai/inspect'
import { createInspectorServer } from '@statelyai/inspect/server'
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import {
  createServices,
  createEpicMachine,
  machineStage,
  type EpicMachineContext,
  type EpicMachineEvent,
} from './machines/epic-machine.ts'
import { readConfig } from './tools.ts'
import type { EpicConfig, EpicStage, EpicState } from './types.ts'

type EpicActor = Actor<ReturnType<typeof createEpicMachine>>

interface EpicInspector {
  inspect: Observer<InspectionEvent>
}

// The Pi extension process owns the live epic session. Keep one relay per
// port so each short-lived command runtime can reconnect its actor without
// tearing down the inspector server after the command returns.
const inspectors = new Map<number, EpicInspector>()

function createEpicInspector(config: EpicConfig['inspector']):
  | EpicInspector
  | undefined {
  const enabled =
    process.env.PI_EPIC_INSPECTOR === '1' || config?.enabled === true
  if (!enabled || process.env.PI_EPIC_INSPECTOR === '0') return undefined

  const configuredPort = Number(
    process.env.PI_EPIC_INSPECTOR_PORT ?? config?.port ?? 8080
  )
  const port =
    Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65536
      ? configuredPort
      : 8080
  const existing = inspectors.get(port)
  if (existing) return existing

  createInspectorServer({
    port,
    autoOpen:
      process.env.PI_EPIC_INSPECTOR_AUTO_OPEN === '1' ||
      (process.env.PI_EPIC_INSPECTOR_AUTO_OPEN !== '0' &&
        (config?.autoOpen ?? true)),
  })
  const inspector = createWebSocketInspector({
    url: `ws://localhost:${port}`,
    sanitizeContext: () => ({}),
  })

  const result = {
    inspect: inspector.inspect,
  }
  inspectors.set(port, result)
  return result
}

export async function createEpicRuntime(
  state: EpicState,
  ctx?: ExtensionCommandContext
): Promise<EpicRuntime> {
  const machine = createEpicMachine(
    ctx ? createServices(ctx) : createServices(undefined as never)
  )
  const config = (await readConfig(state.repositoryRoot)) as EpicConfig
  const inspector = createEpicInspector(config.inspector)
  const actor = state.machineSnapshot
    ? createActor(machine, {
        snapshot: state.machineSnapshot as SnapshotFrom<typeof machine>,
        input: { state },
        inspect: inspector?.inspect,
      })
    : createActor(machine, { input: { state }, inspect: inspector?.inspect })
  actor.start()
  return new EpicRuntime(state, actor)
}

class EpicRuntime {
  private readonly actor: EpicActor
  private readonly state: EpicState
  constructor(state: EpicState, actor: EpicActor) {
    this.state = state
    this.actor = actor
  }
  send(event: EpicMachineEvent): void {
    if (!this.actor.getSnapshot().can(event))
      throw new Error(
        `Epic event ${event.type} is not available in stage ${machineStage(this.actor.getSnapshot() as { context: EpicMachineContext })}.`
      )
    this.actor.send(event)
  }
  async settle(timeoutMs = 300_000): Promise<void> {
    const started = Date.now()
    const waiting = new Set([
      'awaiting_plan_review',
      'awaiting_plan_approval',
      'awaiting_prerequisite_approval',
      'awaiting_task_approval',
      'awaiting_task_review',
      'escalating',
      'completed',
      'failed',
      'cancelled',
    ])
    while (Date.now() - started < timeoutMs) {
      const snapshot = this.actor.getSnapshot() as unknown as {
        context: EpicMachineContext
      }
      // The machine owns the live stage. `context.state.stage` is only
      // synchronized after settle() returns, so reading it here can leave
      // every in-flight epic looking permanently idle.
      if (waiting.has(machineStage(snapshot))) {
        await this.sync()
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(
      'Epic actor did not reach a human or terminal state before timeout.'
    )
  }
  async sync(): Promise<void> {
    const snapshot = this.actor.getSnapshot() as unknown as {
      context: EpicMachineContext
    }
    const current = snapshot.context.state
    Object.assign(this.state, current, {
      machineSnapshot: this.actor.getPersistedSnapshot(),
      stage: machineStage(snapshot),
    })
  }
  snapshot(): ReturnType<EpicActor['getPersistedSnapshot']> {
    return this.actor.getPersistedSnapshot()
  }
  matches(stage: EpicStage): boolean {
    return (
      machineStage(
        this.actor.getSnapshot() as { context: EpicMachineContext }
      ) === stage
    )
  }
  tags(): ReadonlySet<string> {
    return this.actor.getSnapshot().tags
  }
  value(): unknown {
    return this.actor.getSnapshot().value
  }
  stop(): void {
    this.actor.stop()
  }
}
