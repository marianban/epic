import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { appendEvent, loadActiveWorkflow, persistTask, saveState } from "./persistence.ts";
import { createWorkflowState } from "./state.ts";
import { createWorkflowRuntime } from "./runtime.ts";
import type { WorkflowMachineEvent } from "./machines/workflow-machine.ts";
import type { WorkflowState } from "./types.ts";

async function dispatch(state: WorkflowState, ctx: ExtensionCommandContext, event: WorkflowMachineEvent): Promise<void> {
  const runtime = createWorkflowRuntime(state, ctx);
  try { runtime.send(event); await runtime.settle(); await runtime.sync(); await saveState(state); }
  finally { runtime.stop(); }
}

export async function startWorkflow(task: string, ctx: ExtensionCommandContext): Promise<void> {
  if (!task.trim()) throw new Error("Usage: /workflow <task>");
  const root = path.resolve(ctx.cwd); await ensureNoActiveWorkflow(root);
  const state = createWorkflowState(root, task.trim()); await persistTask(state); await appendEvent(state, "workflow_created", { task: state.task });
  const runtime = createWorkflowRuntime(state, ctx);
  try { await runtime.sync(); await saveState(state); runtime.send({ type: "WORKFLOW.START" }); await runtime.settle(); await runtime.sync(); await saveState(state); }
  finally { runtime.stop(); }
  ctx.ui.notify(`Workflow ${state.workflowId} started.`, "info");
}

export async function reviewPlan(ctx: ExtensionCommandContext, force = false): Promise<void> { const state = await loadActiveWorkflow(ctx.cwd); await dispatch(state, ctx, { type: force ? "PLAN.REVISE" : "PLAN.REVIEW", force }); ctx.ui.notify(`Plan review completed for workflow ${state.workflowId}.`); }
export async function approvePlan(ctx: ExtensionCommandContext): Promise<void> { const state = await loadActiveWorkflow(ctx.cwd); await dispatch(state, ctx, { type: "PLAN.APPROVE" }); ctx.ui.notify(`Plan approved for workflow ${state.workflowId}.`); }
export async function approvePrerequisites(ctx: ExtensionCommandContext): Promise<void> { const state = await loadActiveWorkflow(ctx.cwd); await dispatch(state, ctx, { type: "PREREQUISITES.APPROVE" }); }
export async function resumeWorkflow(ctx: ExtensionCommandContext): Promise<void> { const state = await loadActiveWorkflow(ctx.cwd); await dispatch(state, ctx, { type: "WORKFLOW.RESUME" }); }
export async function cancelWorkflow(ctx: ExtensionCommandContext): Promise<void> { const state = await loadActiveWorkflow(ctx.cwd); await dispatch(state, ctx, { type: "WORKFLOW.CANCEL" }); ctx.ui.notify(`Workflow ${state.workflowId} cancelled.`); }
export async function approveTask(ctx: ExtensionCommandContext): Promise<void> { const state = await loadActiveWorkflow(ctx.cwd); await dispatch(state, ctx, { type: "TASK.APPROVE" }); }
export async function reviseTask(ctx: ExtensionCommandContext): Promise<void> { const state = await loadActiveWorkflow(ctx.cwd); await dispatch(state, ctx, { type: "TASK.REVIEW" }); }

export async function workflowStatus(ctx: ExtensionCommandContext): Promise<void> {
  const state = await loadActiveWorkflow(ctx.cwd); const runtime = createWorkflowRuntime(state, ctx);
  try { const task = state.tasks?.[state.currentTaskIndex]; ctx.ui.notify([`Workflow: ${state.workflowId}`, `Stage: ${state.stage}`, `Machine state: ${JSON.stringify(runtime.value())}`, `Tags: ${Array.from(runtime.tags()).join(", ") || "none"}`, task ? `Task: ${state.currentTaskIndex + 1}/${state.tasks?.length} ${task.id} — ${task.title}` : "Tasks: not decomposed", `Pending human action: ${state.pendingHumanAction ?? "none"}`].join("\n")); }
  finally { runtime.stop(); }
}

async function ensureNoActiveWorkflow(root: string): Promise<void> { try { const state = await loadActiveWorkflow(root); if (!["completed", "failed", "cancelled"].includes(state.stage)) throw new Error(`Workflow ${state.workflowId} is already active at stage ${state.stage}.`); } catch (error) { if (error instanceof Error && !/ENOENT|no such file/i.test(error.message)) throw error; } }
