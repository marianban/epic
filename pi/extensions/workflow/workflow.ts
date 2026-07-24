import * as path from 'node:path'
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import {
  appendEvent,
  loadActiveWorkflow,
  persistTask,
  saveState,
} from './persistence.ts'
import { createWorkflowState } from './state.ts'
import { createWorkflowRuntime } from './runtime.ts'
import type { WorkflowMachineEvent } from './machines/workflow-machine.ts'
import type { WorkflowState } from './types.ts'

async function dispatch(
  state: WorkflowState,
  ctx: ExtensionCommandContext,
  event: WorkflowMachineEvent
): Promise<void> {
  const runtime = await createWorkflowRuntime(state, ctx)
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
  state: WorkflowState,
  messages: { completed: string; next?: string }
): void {
  ctx.ui.notify(
    [messages.completed, messages.next].filter(Boolean).join(' '),
    state.stage === 'escalating' ? 'warning' : 'info'
  )
}

export async function startWorkflow(
  task: string,
  ctx: ExtensionCommandContext
): Promise<void> {
  if (!task.trim()) throw new Error('Usage: /workflow <task>')
  const root = path.resolve(ctx.cwd)
  await ensureNoActiveWorkflow(root)
  const state = createWorkflowState(root, task.trim())
  await persistTask(state)
  await appendEvent(state, 'workflow_created', { task: state.task })
  const runtime = await createWorkflowRuntime(state, ctx)
  try {
    await runtime.sync()
    await saveState(state)
    runtime.send({ type: 'WORKFLOW.START' })
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
    [`Workflow ${state.workflowId} started.`, nextAction].filter(Boolean).join(' '),
    'info'
  )
}

export async function reviewPlan(
  ctx: ExtensionCommandContext,
  force = false
): Promise<void> {
  const state = await loadActiveWorkflow(ctx.cwd)
  await dispatch(state, ctx, {
    type: force ? 'PLAN.REVISE' : 'PLAN.REVIEW',
    force,
  })
  notifyNextAction(ctx, state, {
    completed: `Plan review completed for workflow ${state.workflowId}.`,
    next:
      state.stage === 'awaiting_plan_review'
        ? 'Review plan.md and run /plan-review, or run /plan-approve when satisfied.'
        : state.stage === 'awaiting_plan_approval'
          ? 'Review plan.md and run /plan-approve when satisfied.'
          : undefined,
  })
}
export async function approvePlan(ctx: ExtensionCommandContext): Promise<void> {
  const state = await loadActiveWorkflow(ctx.cwd)
  await dispatch(state, ctx, { type: 'PLAN.APPROVE' })
  notifyNextAction(ctx, state, {
    completed: `Plan approved for workflow ${state.workflowId}.`,
    next:
      state.stage === 'awaiting_prerequisite_approval'
        ? 'Review the proposed prerequisite commands and run /workflow-approve-prerequisites to continue.'
        : state.stage === 'awaiting_task_approval'
          ? `Task ${state.currentTaskIndex + 1} is ready for review. Inspect its task artifact, then run /task-approve or /task-review.`
          : undefined,
  })
}
export async function approvePrerequisites(
  ctx: ExtensionCommandContext
): Promise<void> {
  const state = await loadActiveWorkflow(ctx.cwd)
  await dispatch(state, ctx, { type: 'PREREQUISITES.APPROVE' })
  notifyNextAction(ctx, state, {
    completed: `Prerequisites approved for workflow ${state.workflowId}.`,
    next:
      state.stage === 'awaiting_task_approval'
        ? `Task ${state.currentTaskIndex + 1} is ready for review. Inspect its task artifact, then run /task-approve or /task-review.`
        : undefined,
  })
}
export async function resumeWorkflow(
  ctx: ExtensionCommandContext
): Promise<void> {
  const state = await loadActiveWorkflow(ctx.cwd)
  await dispatch(state, ctx, { type: 'WORKFLOW.RESUME' })
  notifyNextAction(ctx, state, {
    completed: `Workflow ${state.workflowId} resumed.`,
    next:
      state.stage === 'awaiting_task_review'
        ? `Review Task ${state.currentTaskIndex + 1}'s implementation and run /task-approve, or add R: findings and run /task-review.`
        : state.stage === 'awaiting_task_approval'
          ? `Task ${state.currentTaskIndex + 1} is ready for review. Inspect its task artifact, then run /task-approve or /task-review.`
          : state.stage === 'escalating'
            ? 'Inspect the failure and run /workflow-resume to retry, or /workflow-cancel.'
            : undefined,
  })
}
export async function cancelWorkflow(
  ctx: ExtensionCommandContext
): Promise<void> {
  const state = await loadActiveWorkflow(ctx.cwd)
  await dispatch(state, ctx, { type: 'WORKFLOW.CANCEL' })
  ctx.ui.notify(`Workflow ${state.workflowId} cancelled.`)
}
export async function approveTask(ctx: ExtensionCommandContext): Promise<void> {
  const state = await loadActiveWorkflow(ctx.cwd)
  await dispatch(state, ctx, { type: 'TASK.APPROVE' })
  notifyNextAction(ctx, state, {
    completed: `Task approval processed for workflow ${state.workflowId}.`,
    next:
      state.stage === 'awaiting_task_review'
        ? `Review Task ${state.currentTaskIndex + 1}'s implementation and run /task-approve, or add R: findings and run /task-review.`
        : state.stage === 'awaiting_task_approval'
          ? `Task ${state.currentTaskIndex + 1} is ready for review. Inspect its task artifact, then run /task-approve or /task-review.`
          : state.stage === 'escalating'
            ? 'Inspect the failure and run /workflow-resume to retry, or /workflow-cancel.'
            : undefined,
  })
}
export async function reviseTask(ctx: ExtensionCommandContext): Promise<void> {
  const state = await loadActiveWorkflow(ctx.cwd)
  await dispatch(state, ctx, { type: 'TASK.REVIEW' })
  notifyNextAction(ctx, state, {
    completed: `Task review completed for workflow ${state.workflowId}.`,
    next:
      state.stage === 'awaiting_task_approval'
        ? `Task ${state.currentTaskIndex + 1} was revised and is ready for approval. Run /task-approve when satisfied.`
        : state.stage === 'awaiting_task_review'
          ? `Review Task ${state.currentTaskIndex + 1}'s implementation and run /task-approve, or add R: findings and run /task-review.`
          : undefined,
  })
}

export async function workflowStatus(
  ctx: ExtensionCommandContext
): Promise<void> {
  const state = await loadActiveWorkflow(ctx.cwd)
  const runtime = await createWorkflowRuntime(state, ctx)
  try {
    const task = state.tasks?.[state.currentTaskIndex]
    ctx.ui.notify(
      [
        `Workflow: ${state.workflowId}`,
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

async function ensureNoActiveWorkflow(root: string): Promise<void> {
  try {
    const state = await loadActiveWorkflow(root)
    if (!['completed', 'failed', 'cancelled'].includes(state.stage))
      throw new Error(
        `Workflow ${state.workflowId} is already active at stage ${state.stage}.`
      )
  } catch (error) {
    if (error instanceof Error && !/ENOENT|no such file/i.test(error.message))
      throw error
  }
}
