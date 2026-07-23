import { createActor, type Actor, type SnapshotFrom } from 'xstate'
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import {
  createServices,
  createWorkflowMachine,
  machineStage,
  type WorkflowMachineContext,
  type WorkflowMachineEvent,
} from './machines/workflow-machine.ts'
import type { WorkflowStage, WorkflowState } from './types.ts'

export type WorkflowActor = Actor<ReturnType<typeof createWorkflowMachine>>

export function createWorkflowRuntime(
  state: WorkflowState,
  ctx?: ExtensionCommandContext
): WorkflowRuntime {
  const machine = createWorkflowMachine(
    ctx ? createServices(ctx) : createServices(undefined as never)
  )
  const actor = state.machineSnapshot
    ? createActor(machine, {
        snapshot: state.machineSnapshot as SnapshotFrom<typeof machine>,
        input: { state },
      })
    : createActor(machine, { input: { state } })
  actor.start()
  return new WorkflowRuntime(state, actor)
}

export class WorkflowRuntime {
  private readonly actor: WorkflowActor
  private readonly state: WorkflowState
  constructor(state: WorkflowState, actor: WorkflowActor) {
    this.state = state
    this.actor = actor
  }
  send(event: WorkflowMachineEvent): void {
    if (!this.actor.getSnapshot().can(event))
      throw new Error(
        `Workflow event ${event.type} is not available in stage ${machineStage(this.actor.getSnapshot() as { context: WorkflowMachineContext })}.`
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
        context: WorkflowMachineContext
      }
      if (waiting.has(snapshot.context.state.stage)) {
        await this.sync()
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(
      'Workflow actor did not reach a human or terminal state before timeout.'
    )
  }
  async sync(): Promise<void> {
    const snapshot = this.actor.getSnapshot() as unknown as {
      context: WorkflowMachineContext
    }
    const current = snapshot.context.state
    Object.assign(this.state, current, {
      machineSnapshot: this.actor.getPersistedSnapshot(),
      stage: machineStage(snapshot),
    })
  }
  snapshot(): ReturnType<WorkflowActor['getPersistedSnapshot']> {
    return this.actor.getPersistedSnapshot()
  }
  matches(stage: WorkflowStage): boolean {
    return (
      machineStage(
        this.actor.getSnapshot() as { context: WorkflowMachineContext }
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
