import * as path from 'node:path'
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import {
  appendEvent,
  loadActiveEpic,
  persistEpic,
  saveState,
} from './persistence.ts'
import { createEpicState } from './state.ts'
import { createEpicRuntime } from './runtime.ts'
import type { EpicMachineEvent } from './machines/epic-machine.ts'
import type { EpicState } from './types.ts'

async function dispatch(
  state: EpicState,
  ctx: ExtensionCommandContext,
  event: EpicMachineEvent
): Promise<void> {
  const runtime = await createEpicRuntime(state, ctx)
  try {
    runtime.send(event)
    await runtime.settle()
    await runtime.sync()
    await saveState(state)
  } finally {
    runtime.stop()
  }
}

function notifyNextAction(
  ctx: ExtensionCommandContext,
  state: EpicState,
  messages: { completed: string; next?: string }
): void {
  ctx.ui.notify(
    [messages.completed, messages.next].filter(Boolean).join(' '),
    state.stage === 'escalating' ? 'warning' : 'info'
  )
}

export async function startEpic(
  epic: string,
  ctx: ExtensionCommandContext
): Promise<void> {
  if (!epic.trim()) throw new Error('Usage: /epic <epic>')
  const root = path.resolve(ctx.cwd)
  await ensureNoActiveEpic(root)
  const state = createEpicState(root, epic.trim())
  await persistEpic(state)
  await appendEvent(state, 'epic_created', { epic: state.epic })
  const runtime = await createEpicRuntime(state, ctx)
  try {
    await runtime.sync()
    await saveState(state)
    runtime.send({ type: 'EPIC.START' })
    await runtime.settle()
    await runtime.sync()
    await saveState(state)
  } finally {
    runtime.stop()
  }
  const nextAction =
    state.stage === 'awaiting_plan_review'
      ? 'Plan is ready for review. Use /plan-review or /plan-approve.'
      : state.stage === 'awaiting_plan_approval'
        ? 'Plan is ready for approval. Use /plan-approve.'
        : undefined
  ctx.ui.notify(
    [`Epic ${state.epicId} started.`, nextAction].filter(Boolean).join(' '),
    'info'
  )
}

export async function reviewPlan(
  ctx: ExtensionCommandContext,
  force = false
): Promise<void> {
  const state = await loadActiveEpic(ctx.cwd)
  await dispatch(state, ctx, {
    type: force ? 'PLAN.REVISE' : 'PLAN.REVIEW',
    force,
  })
  notifyNextAction(ctx, state, {
    completed: `Plan review completed for epic ${state.epicId}.`,
    next:
      state.stage === 'awaiting_plan_review'
        ? 'Review plan.md and run /plan-review, or run /plan-approve when satisfied.'
        : state.stage === 'awaiting_plan_approval'
          ? 'Review plan.md and run /plan-approve when satisfied.'
          : undefined,
  })
}
export async function approvePlan(ctx: ExtensionCommandContext): Promise<void> {
  const state = await loadActiveEpic(ctx.cwd)
  await dispatch(state, ctx, { type: 'PLAN.APPROVE' })
  notifyNextAction(ctx, state, {
    completed: `Plan approved for epic ${state.epicId}.`,
    next:
      state.stage === 'awaiting_prerequisite_approval'
        ? 'Review the proposed prerequisite commands and run /epic-approve-prerequisites to continue.'
        : state.stage === 'awaiting_task_approval'
          ? `Task ${state.currentTaskIndex + 1} is ready for review. Inspect its task artifact, then run /task-approve or /task-review.`
          : undefined,
  })
}
export async function approvePrerequisites(
  ctx: ExtensionCommandContext
): Promise<void> {
  const state = await loadActiveEpic(ctx.cwd)
  await dispatch(state, ctx, { type: 'PREREQUISITES.APPROVE' })
  notifyNextAction(ctx, state, {
    completed: `Prerequisites approved for epic ${state.epicId}.`,
    next:
      state.stage === 'awaiting_task_approval'
        ? `Task ${state.currentTaskIndex + 1} is ready for review. Inspect its task artifact, then run /task-approve or /task-review.`
        : undefined,
  })
}
export async function resumeEpic(
  ctx: ExtensionCommandContext
): Promise<void> {
  const state = await loadActiveEpic(ctx.cwd)
  await dispatch(state, ctx, { type: 'EPIC.RESUME' })
  notifyNextAction(ctx, state, {
    completed: `Epic ${state.epicId} resumed.`,
    next:
      state.stage === 'awaiting_task_review'
        ? `Review Task ${state.currentTaskIndex + 1}'s implementation and run /task-approve, or add R: findings and run /task-review.`
        : state.stage === 'awaiting_task_approval'
          ? `Task ${state.currentTaskIndex + 1} is ready for review. Inspect its task artifact, then run /task-approve or /task-review.`
          : state.stage === 'escalating'
            ? 'Inspect the failure and run /epic-resume to retry, or /epic-cancel.'
            : undefined,
  })
}
export async function cancelEpic(
  ctx: ExtensionCommandContext
): Promise<void> {
  const state = await loadActiveEpic(ctx.cwd)
  await dispatch(state, ctx, { type: 'EPIC.CANCEL' })
  ctx.ui.notify(`Epic ${state.epicId} cancelled.`)
}
export async function approveTask(ctx: ExtensionCommandContext): Promise<void> {
  const state = await loadActiveEpic(ctx.cwd)
  await dispatch(state, ctx, { type: 'TASK.APPROVE' })
  notifyNextAction(ctx, state, {
    completed: `Task approval processed for epic ${state.epicId}.`,
    next:
      state.stage === 'awaiting_task_review'
        ? `Review Task ${state.currentTaskIndex + 1}'s implementation and run /task-approve, or add R: findings and run /task-review.`
        : state.stage === 'awaiting_task_approval'
          ? `Task ${state.currentTaskIndex + 1} is ready for review. Inspect its task artifact, then run /task-approve or /task-review.`
          : state.stage === 'escalating'
            ? 'Inspect the failure and run /epic-resume to retry, or /epic-cancel.'
            : undefined,
  })
}
export async function reviseTask(ctx: ExtensionCommandContext): Promise<void> {
  const state = await loadActiveEpic(ctx.cwd)
  await dispatch(state, ctx, { type: 'TASK.REVIEW' })
  notifyNextAction(ctx, state, {
    completed: `Task review completed for epic ${state.epicId}.`,
    next:
      state.stage === 'awaiting_task_approval'
        ? `Task ${state.currentTaskIndex + 1} was revised and is ready for approval. Run /task-approve when satisfied.`
        : state.stage === 'awaiting_task_review'
          ? `Review Task ${state.currentTaskIndex + 1}'s implementation and run /task-approve, or add R: findings and run /task-review.`
          : undefined,
  })
}

export async function epicStatus(
  ctx: ExtensionCommandContext
): Promise<void> {
  const state = await loadActiveEpic(ctx.cwd)
  const runtime = await createEpicRuntime(state, ctx)
  try {
    const task = state.tasks?.[state.currentTaskIndex]
    ctx.ui.notify(
      [
        `Epic: ${state.epicId}`,
        `Stage: ${state.stage}`,
        `Machine state: ${JSON.stringify(runtime.value())}`,
        `Tags: ${Array.from(runtime.tags()).join(', ') || 'none'}`,
        task
          ? `Task: ${state.currentTaskIndex + 1}/${state.tasks?.length} ${task.id} — ${task.title}`
          : 'Tasks: not decomposed',
        `Pending human action: ${state.pendingHumanAction ?? 'none'}`,
      ].join('\n')
    )
  } finally {
    runtime.stop()
  }
}

async function ensureNoActiveEpic(root: string): Promise<void> {
  try {
    const state = await loadActiveEpic(root)
    if (!['completed', 'failed', 'cancelled'].includes(state.stage))
      throw new Error(
        `Epic ${state.epicId} is already active at stage ${state.stage}.`
      )
  } catch (error) {
    if (error instanceof Error && !/ENOENT|no such file/i.test(error.message))
      throw error
  }
}
