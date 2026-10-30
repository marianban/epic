import { acceptancePlanningFailureMessage } from './acceptance-planning-recovery.ts'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import {
  appendEvent,
  loadActiveEpic,
  persistEpic,
  saveState,
} from './persistence.ts'
import { createEpicState } from './state.ts'
import { createEpicRuntime } from './runtime.ts'
import { humanContinuation } from './human-actions.ts'
import { currentTaskArtifactPath } from './artifact-paths.ts'
import { withActiveEpicOperation } from './operation-status.ts'
import { domainFromActorSnapshot } from './domain-validation.ts'
import { resolveEpicConfiguration } from './configuration.ts'
import { activeAgentRuns } from './agent-activity.ts'
import { recoverInterruptedAgentRuns } from './agent-recovery.ts'
import { humanRepairFeedback } from './manual-review.ts'
import { latestTaskRepairRequest } from './task-repair-request.ts'
import { VerificationStore, taskVerificationPath } from './verification-store.ts'
import type { EpicMachineEvent } from './machines/epic-machine.ts'
import type {
  EpicBoundaryView,
  EpicClock,
  EpicDomainState,
  EpicRunMetadata,
  EpicTimer,
  PersistedEpicEnvelope,
} from './types.ts'

interface EpicRunView {
  domain: EpicDomainState
  metadata: EpicRunMetadata
  boundary: EpicBoundaryView
}
const systemClock: EpicClock = {
  now: () => new Date().toISOString(),
  nowMs: () => Date.now(),
}
const systemTimer: EpicTimer = { setTimeout, clearTimeout }
async function dispatch(
  envelope: PersistedEpicEnvelope,
  ctx: ExtensionContext,
  event: EpicMachineEvent
): Promise<EpicRunView> {
  const domain = domainFromActorSnapshot(envelope.snapshot)
  const configuration = await resolveEpicConfiguration(domain.repositoryRoot)
  return withActiveEpicOperation(envelope.epicId, async () => {
    const recoveryTimestamp = systemClock.now()
    const recoveryNowMs = Date.parse(recoveryTimestamp)
    if (Number.isNaN(recoveryNowMs)) {
      throw new Error(`System clock returned an invalid timestamp: ${recoveryTimestamp}`)
    }
    await recoverInterruptedAgentRuns(
      domain,
      recoveryTimestamp,
      recoveryNowMs,
      activeAgentRuns(domain.repositoryRoot, domain.epicId, recoveryNowMs)
    )
    const runtime = await createEpicRuntime(
      domain,
      envelope,
      ctx,
      systemClock,
      systemTimer,
      configuration,
      envelope.snapshot
    )
    try {
      const boundary = await runtime.dispatchAndSettle(
        event,
        runtime.boundary().task ? undefined : configuration.agentTimeoutMs
      )
      const nextDomain = runtime.domain()
      const nextEnvelope = runtime.envelope(systemClock.now())
      await saveState(nextDomain, nextEnvelope)
      return { domain: nextDomain, metadata: nextEnvelope, boundary }
    } finally {
      runtime.stop()
    }
  })
}
export function formatEscalationMessage(
  view: Pick<EpicRunView, 'domain' | 'boundary'>,
  next?: string
): string | undefined {
  const failureReason =
    view.domain.failureReason ?? view.boundary.failureDiagnostics?.reason
  if (view.boundary.stage === 'acceptance_planning_failed') {
    return [acceptancePlanningFailureMessage(view.boundary.task?.state ?? ''), failureReason, 'Use /epic-resume to retry acceptance planning, or /epic-exit.'].filter(Boolean).join('. ')
  }
  if (view.boundary.stage !== 'escalating' || !failureReason)
    return next
  return [failureReason, next].filter(Boolean).join(' ')
}
function notifyNextAction(
  ctx: ExtensionContext,
  view: EpicRunView,
  completed: string,
  next?: string
): void {
  ctx.ui.notify(
    [completed, formatEscalationMessage(view, next)].filter(Boolean).join(' '),
    view.boundary.stage === 'escalating' || view.boundary.stage === 'recovering' || view.boundary.stage === 'acceptance_planning_failed'
      ? 'warning'
      : 'info'
  )
}
export async function startEpic(
  epic: string,
  ctx: ExtensionContext
): Promise<void> {
  if (!epic.trim()) throw new Error('Usage: /epic <epic>')
  const root = path.resolve(ctx.cwd)
  await ensureNoActiveEpic(root)
  const configuration = await resolveEpicConfiguration(root)
  const seed = createEpicState(root, epic.trim(), systemClock.now(), configuration)
  await withActiveEpicOperation(seed.domain.epicId, async () => {
    const runtime = await createEpicRuntime(
      seed.domain,
      seed.metadata,
      ctx,
      systemClock,
      systemTimer,
      configuration
    )
    try {
      await saveState(seed.domain, runtime.envelope(seed.metadata.updatedAt))
      await persistEpic(seed.domain)
      await appendEvent(
        seed.domain,
        runtime.boundary().stage,
        systemClock.now(),
        'epic_created',
        { epic: seed.domain.epic }
      )
      const boundary = await runtime.dispatchAndSettle(
        { type: 'EPIC.START' },
        configuration.agentTimeoutMs
      )
      const envelope = runtime.envelope(systemClock.now())
      await saveState(runtime.domain(), envelope)
      notifyNextAction(
        ctx,
        { domain: runtime.domain(), metadata: envelope, boundary },
        `Epic ${seed.domain.epicId} started.`
      )
    } finally {
      runtime.stop()
    }
  })
}
async function active(
  ctx: ExtensionContext,
  event: EpicMachineEvent
): Promise<EpicRunView> {
  return dispatch(await loadActiveEpic(ctx.cwd), ctx, event)
}
export async function reviewPlan(
  ctx: ExtensionContext,
  force = false
): Promise<void> {
  const view = await active(ctx, {
    type: force ? 'PLAN.REVISE' : 'PLAN.REVIEW',
    force,
  })
  notifyNextAction(
    ctx,
    view,
    `Plan review completed for epic ${view.metadata.epicId}.`
  )
}
export async function approvePlan(ctx: ExtensionContext): Promise<void> {
  const envelope = await loadActiveEpic(ctx.cwd)
  const domain = domainFromActorSnapshot(envelope.snapshot)
  const plan = await fs.readFile(domain.planPath, 'utf8')
  const view = await dispatch(envelope, ctx, {
    type: humanContinuation(plan) === 'review' ? 'PLAN.REVIEW' : 'PLAN.APPROVE',
  })
  notifyNextAction(ctx, view, `Plan approved for epic ${view.metadata.epicId}.`)
}
export async function approvePrerequisites(
  ctx: ExtensionContext
): Promise<void> {
  const view = await active(ctx, { type: 'PREREQUISITES.APPROVE' })
  notifyNextAction(
    ctx,
    view,
    `Prerequisites approved for epic ${view.metadata.epicId}.`
  )
}
export async function resumeEpic(ctx: ExtensionContext): Promise<void> {
  const view = await active(ctx, { type: 'EPIC.RESUME' })
  notifyNextAction(ctx, view, `Epic ${view.metadata.epicId} resumed.`)
}
export async function approveRecovery(ctx: ExtensionContext): Promise<void> {
  const view = await active(ctx, { type: 'RECOVERY.APPROVE' })
  notifyNextAction(
    ctx,
    view,
    `Recovery approved for epic ${view.metadata.epicId}.`
  )
}
export async function approveTask(ctx: ExtensionContext): Promise<void> {
  const envelope = await loadActiveEpic(ctx.cwd)
  const domain = domainFromActorSnapshot(envelope.snapshot)
  const artifact = await fs.readFile(currentTaskArtifactPath(domain), 'utf8')
  const view = await dispatch(envelope, ctx, {
    type:
      humanContinuation(artifact) === 'review' ? 'TASK.REVIEW' : 'TASK.APPROVE',
  })
  notifyNextAction(
    ctx,
    view,
    `Task approval processed for epic ${view.metadata.epicId}.`
  )
}
export async function reviseTask(ctx: ExtensionContext): Promise<void> {
  const view = await active(ctx, { type: 'TASK.REVIEW' })
  notifyNextAction(
    ctx,
    view,
    `Task review completed for epic ${view.metadata.epicId}.`
  )
}
export async function repairTaskCommand(ctx: ExtensionContext, args: string): Promise<void> {
  if (args.trim()) throw new Error('/task-repair takes no arguments. Run /task-repair to repair the latest task report.')
  const envelope = await loadActiveEpic(ctx.cwd)
  const domain = domainFromActorSnapshot(envelope.snapshot)
  const record = await new VerificationStore(taskVerificationPath(domain), systemClock).read()
  const request = latestTaskRepairRequest(record.report, { repairs: 1, timeMs: 300_000 }, !!humanRepairFeedback(record))
  const view = await dispatch(envelope, ctx, { type: 'TASK.DECIDE', request })
  if (view.boundary.task?.failureReason) throw new Error(view.boundary.task.failureReason)
  notifyNextAction(ctx, view, 'Granted one repair attempt and five additional minutes for the latest task report.')
}
export async function epicStatus(ctx: ExtensionContext): Promise<void> {
  const envelope = await loadActiveEpic(ctx.cwd)
  const domain = domainFromActorSnapshot(envelope.snapshot)
  const configuration = await resolveEpicConfiguration(domain.repositoryRoot)
  const runtime = await createEpicRuntime(
    domain,
    envelope,
    ctx,
    systemClock,
    systemTimer,
    configuration,
    envelope.snapshot
  )
  try {
    const boundary = runtime.boundary()
    ctx.ui.notify(
      [
        `Epic: ${envelope.epicId}`,
        `Stage: ${boundary.stage}`,
        `Machine state: ${JSON.stringify(runtime.value())}`,
        `Tags: ${Array.from(runtime.tags()).join(', ') || 'none'}`,
        `Pending human action: ${boundary.pendingHumanAction ?? 'none'}`,
        ...(boundary.stage === 'acceptance_planning_failed' ? [acceptancePlanningFailureMessage(boundary.task?.state ?? ''), runtime.domain().failureReason ?? '', 'Use /epic-resume to retry acceptance planning, or /epic-exit.'] : []),
      ].join('\n')
    )
  } finally {
    runtime.stop()
  }
}
async function ensureNoActiveEpic(root: string): Promise<void> {
  try {
    const envelope = await loadActiveEpic(root)
    const domain = domainFromActorSnapshot(envelope.snapshot)
    const snapshot = envelope.snapshot as {
      value: unknown
      children?: Record<string, unknown>
    }
    const { projectActorSystemSnapshot } =
      await import('./machines/actor-system-projection.ts')
    const boundary = projectActorSystemSnapshot(snapshot)
    if (boundary.wait !== 'terminal')
      throw new Error(
        `Epic ${domain.epicId} is already active at stage ${boundary.stage}.`
      )
  } catch (error) {
    if (error instanceof Error && !/ENOENT|no such file/i.test(error.message))
      throw error
  }
}

export async function submitTaskDecision(ctx: ExtensionContext, request: import('./verification-types.ts').TaskDecisionRequest): Promise<void> {
  const view = await active(ctx, { type: 'TASK.DECIDE', request })
  if (view.boundary.task?.failureReason) throw new Error(view.boundary.task.failureReason)
}
