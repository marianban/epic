import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ScoutReport, WorkflowEvent, WorkflowState } from "./types.ts";
import { assertTransition } from "./state.ts";
import { logWorkflow } from "./logger.ts";

export function runDirectory(root: string, workflowId: string): string { return path.join(root, ".pi", "workflows", "runs", workflowId); }
export function workflowStatePath(root: string, id: string): string { return path.join(runDirectory(root, id), "state.json"); }

export async function ensureWorkflowDirectories(root: string, id: string): Promise<string> {
  const dir = runDirectory(root, id);
  await fs.mkdir(path.join(dir, "plan-revisions"), { recursive: true });
  await fs.mkdir(path.join(dir, "checks"), { recursive: true });
  await fs.mkdir(path.join(dir, "reviews"), { recursive: true });
  await fs.mkdir(path.join(dir, "diffs"), { recursive: true });
  return dir;
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, content, "utf8");
  await fs.rename(temporary, filePath);
}

export async function saveState(state: WorkflowState): Promise<void> {
  await ensureWorkflowDirectories(state.repositoryRoot, state.workflowId);
  state.updatedAt = new Date().toISOString();
  await atomicWrite(workflowStatePath(state.repositoryRoot, state.workflowId), `${JSON.stringify(state, null, 2)}\n`);
  await atomicWrite(path.join(state.repositoryRoot, ".pi", "workflows", "active.json"), `${JSON.stringify({ workflowId: state.workflowId }, null, 2)}\n`);
  await logWorkflow(state, "debug", "Workflow state saved", { stage: state.stage });
}

export async function loadState(root: string, workflowId: string): Promise<WorkflowState> {
  const raw = await fs.readFile(workflowStatePath(root, workflowId), "utf8");
  try {
    const state = JSON.parse(raw) as WorkflowState;
    // Migrate runs created before focused Scout rounds were persisted.
    return {
      ...state,
      scoutRound: state.scoutRound ?? 0,
      maxScoutRounds: state.maxScoutRounds ?? 3,
      implementationAttempt: state.implementationAttempt ?? 0,
      fastRepairAttempt: state.fastRepairAttempt ?? 0,
      fullRepairAttempt: state.fullRepairAttempt ?? 0,
      semanticRepairAttempt: state.semanticRepairAttempt ?? 0,
      maxFastRepairs: state.maxFastRepairs ?? 2,
      maxFullRepairs: state.maxFullRepairs ?? 1,
      maxSemanticRepairs: state.maxSemanticRepairs ?? 2,
    };
  } catch (error) { throw new Error(`Corrupt workflow state at ${workflowStatePath(root, workflowId)}: ${String(error)}`); }
}

export async function loadActiveWorkflow(root: string): Promise<WorkflowState> {
  const active = JSON.parse(await fs.readFile(path.join(root, ".pi", "workflows", "active.json"), "utf8")) as { workflowId?: string };
  if (!active.workflowId) throw new Error("Active workflow pointer is missing workflowId.");
  return loadState(root, active.workflowId);
}

export async function appendEvent(state: WorkflowState, type: string, payload: Record<string, unknown> = {}): Promise<void> {
  const event: WorkflowEvent = { id: randomUUID(), workflowId: state.workflowId, timestamp: new Date().toISOString(), type, stage: state.stage, payload };
  await fs.appendFile(path.join(runDirectory(state.repositoryRoot, state.workflowId), "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
  await logWorkflow(state, "info", type, { stage: state.stage, ...payload });
}

export async function transition(state: WorkflowState, next: WorkflowState["stage"], payload: Record<string, unknown> = {}): Promise<void> {
  const previous = state.stage;
  assertTransition(state, next);
  state.stage = next;
  await saveState(state);
  await appendEvent(state, "stage_changed", { from: previous, to: next, ...payload });
}

export async function persistJsonArtifact(state: WorkflowState, relativePath: string, value: unknown): Promise<string> {
  const filePath = path.join(runDirectory(state.repositoryRoot, state.workflowId), relativePath);
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return filePath;
}

export async function persistScoutReport(state: WorkflowState, report: ScoutReport): Promise<string> {
  const latest = await persistJsonArtifact(state, "scout-report.json", report);
  await persistJsonArtifact(state, `scout-reports/scout-${String(state.scoutRound).padStart(3, "0")}.json`, report);
  return latest;
}

export async function persistTask(state: WorkflowState): Promise<string> {
  const filePath = path.join(runDirectory(state.repositoryRoot, state.workflowId), "task.md");
  await atomicWrite(filePath, `# Workflow Task\n\n${state.task}\n`);
  return filePath;
}

export async function writePlanRevision(state: WorkflowState, markdown: string): Promise<string> {
  const revision = state.planRevision + 1;
  const filePath = path.join(runDirectory(state.repositoryRoot, state.workflowId), "plan-revisions", `plan-${String(revision).padStart(3, "0")}.md`);
  await atomicWrite(filePath, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  state.planRevision = revision;
  await saveState(state);
  await appendEvent(state, "plan_written", { revision, path: filePath });
  return filePath;
}

export async function markTerminal(state: WorkflowState, stage: "failed" | "cancelled", reason?: string): Promise<void> {
  if (reason) state.failureReason = reason;
  await transition(state, stage, { reason });
  await appendEvent(state, stage === "failed" ? "workflow_failed" : "workflow_cancelled", { reason });
}
