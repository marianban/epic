import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseJsonResponse, parseMarkdownResponse, parsePlannerResponse, runAgent } from "./agents.ts";
import { appendEvent, loadActiveWorkflow, markTerminal, persistScoutReport, persistTask, saveState, transition, writePlanRevision } from "./persistence.ts";
import { extractReviewInstructions, hashPlan, validatePlanCompleteness, validatePlanRevision } from "./plan-review.ts";
import { assertStage, classifyTask, createWorkflowState } from "./state.ts";
import { plannerTask, scoutTask } from "./prompts.ts";
import type { ScoutReport, WorkflowConfig, WorkflowState } from "./types.ts";

/** Phase one deliberately ends after an explicitly approved plan. */
export async function startWorkflow(task: string, ctx: ExtensionCommandContext): Promise<void> {
  const root = path.resolve(ctx.cwd);
  if (!task.trim()) throw new Error("Usage: /workflow <task>");
  await ensureNoActiveWorkflow(root);
  const state = createWorkflowState(root, task.trim());
  await saveState(state);
  await persistTask(state);
  await appendEvent(state, "workflow_created", { task: state.task });
  notify(ctx, `Workflow ${state.workflowId} started. Running the read-only Scout, then Planner.`);
  try {
    await transition(state, "classifying");
    state.taskComplexity = classifyTask(state.task);
    await saveState(state);
    await transition(state, "scouting");
    await discoverAndPlan(state, ctx, true);
  } catch (error) {
    await failSafely(state, error);
    notify(ctx, `Workflow ${state.workflowId} failed: ${String(error)}`, "error");
    throw error;
  }
}

export async function reviewPlan(ctx: ExtensionCommandContext, force = false): Promise<void> {
  const state = await loadActiveWorkflow(ctx.cwd);
  assertStage(state, ["awaiting_plan_review", "awaiting_plan_approval"]);
  const current = await fs.readFile(state.planPath, "utf8");
  const instructions = extractReviewInstructions(current);
  if (!force && instructions.length === 0) {
    state.pendingHumanAction = "approve_plan";
    await saveState(state);
    if (state.stage === "awaiting_plan_review") await transition(state, "awaiting_plan_approval");
    notify(ctx, "No R: comments found. Review plan.md and run /plan-approve, or add R: comments and run /plan-review.");
    return;
  }
  await transition(state, "revising_plan");
  const report = await readScoutReport(state);
  const run = await runRole(ctx, state, "planner", plannerTask(state, report, current, instructions), "plan revision");
  if (run.exitCode !== 0) throw new Error(`Planner revision failed: ${run.stderr || run.output.slice(-2_000)}`);
  const revised = parseMarkdownResponse(run.output, "planner");
  validatePlanRevision(current, revised, instructions);
  await writePlanRevision(state, revised);
  await fs.writeFile(state.planPath, `${revised}\n`, "utf8");
  state.planApproved = false;
  state.approvedPlanHash = undefined;
  state.pendingHumanAction = "review_plan";
  await saveState(state);
  await transition(state, "awaiting_plan_review");
  notify(ctx, `plan.md revised to revision ${state.planRevision}. Review it again or run /plan-approve.`);
}

export async function approvePlan(ctx: ExtensionCommandContext): Promise<void> {
  const state = await loadActiveWorkflow(ctx.cwd);
  assertStage(state, ["awaiting_plan_review", "awaiting_plan_approval"]);
  const plan = await fs.readFile(state.planPath, "utf8");
  if (extractReviewInstructions(plan).length > 0) throw new Error("plan.md still contains unresolved R: comments. Run /plan-review first.");
  const validation = validatePlanCompleteness(plan);
  if (!validation.valid) throw new Error(`Cannot approve plan: ${validation.errors.join(" ")}`);
  state.planApproved = true;
  state.planApprovedAt = new Date().toISOString();
  state.approvedPlanHash = hashPlan(plan);
  state.pendingHumanAction = "none";
  await saveState(state);
  await appendEvent(state, "plan_approved", { revision: state.planRevision, hash: state.approvedPlanHash });
  if (state.stage === "awaiting_plan_review") await transition(state, "awaiting_plan_approval");
  await transition(state, "completed", { phase: "planning", nextPhase: "implementation" });
  await appendEvent(state, "planning_phase_completed", { planPath: state.planPath });
  notify(ctx, `Workflow ${state.workflowId} planning phase completed. Implementation agents are not enabled yet.`);
}

export async function resumeWorkflow(ctx: ExtensionCommandContext): Promise<void> {
  const state = await loadActiveWorkflow(ctx.cwd);
  if (["completed", "cancelled"].includes(state.stage)) { notify(ctx, `Workflow ${state.workflowId} is already ${state.stage}.`); return; }
  if (["awaiting_plan_review", "awaiting_plan_approval"].includes(state.stage)) { notify(ctx, `Workflow ${state.workflowId} is paused at ${state.stage}. Pending action: ${state.pendingHumanAction ?? "none"}.`); return; }
  if (state.stage === "scouting") { await discoverAndPlan(state, ctx, true); return; }
  if (state.stage === "planning") { await discoverAndPlan(state, ctx, false); return; }
  throw new Error(`Workflow cannot resume from stage ${state.stage}.`);
}

export async function cancelWorkflow(ctx: ExtensionCommandContext): Promise<void> {
  const state = await loadActiveWorkflow(ctx.cwd);
  if (["completed", "failed", "cancelled"].includes(state.stage)) { notify(ctx, `Workflow is already ${state.stage}.`); return; }
  await markTerminal(state, "cancelled", "Cancelled by user; repository changes were not reverted.");
  notify(ctx, `Workflow ${state.workflowId} cancelled.`);
}

export async function workflowStatus(ctx: ExtensionCommandContext): Promise<void> {
  const state = await loadActiveWorkflow(ctx.cwd);
  notify(ctx, [`Workflow: ${state.workflowId}`, `Stage: ${state.stage}`, `Active agent: ${activeAgent(state.stage)}`, `Plan: revision ${state.planRevision}, ${state.planApproved ? "approved" : "not approved"}`, `Pending human action: ${state.pendingHumanAction ?? "none"}`].join("\n"));
}

async function discoverAndPlan(state: WorkflowState, ctx: ExtensionCommandContext, runScout: boolean): Promise<void> {
  let report: ScoutReport;
  if (runScout) {
    state.scoutRound += 1;
    await saveState(state);
    const run = await runRole(ctx, state, "scout", scoutTask(state), "repository discovery");
    if (run.exitCode !== 0) throw new Error(`Scout failed: ${run.stderr || run.output.slice(-2_000)}`);
    report = parseJsonResponse<ScoutReport>(run.output, "scout");
    state.scoutReportPath = await persistScoutReport(state, report);
    await saveState(state);
  } else report = await readScoutReport(state);
  if (state.stage === "scouting") await transition(state, "planning");
  while (true) {
    const run = await runRole(ctx, state, "planner", plannerTask(state, report, null), "initial planning");
    if (run.exitCode !== 0) throw new Error(`Planner failed: ${run.stderr || run.output.slice(-2_000)}`);
    const response = parsePlannerResponse(run.output);
    if (typeof response === "string") {
      await writePlanRevision(state, response);
      await fs.writeFile(state.planPath, `${response}\n`, "utf8");
      await transition(state, "awaiting_plan_review");
      state.pendingHumanAction = "review_plan";
      await saveState(state);
      notify(ctx, `Workflow ${state.workflowId} paused for plan review. Review plan.md, add R: comments if needed, then run /plan-review or /plan-approve.`);
      return;
    }
    const maxRounds = (await readConfigValue(state.repositoryRoot)).maxScoutRounds ?? state.maxScoutRounds;
    if (state.scoutRound >= maxRounds) throw new Error(`Planner requested more Scout context after the maximum of ${maxRounds} rounds.`);
    await transition(state, "scouting", { reason: "planner_requested_focused_context" });
    state.scoutRound += 1;
    const followUp = await runRole(ctx, state, "scout", scoutTask(state, response.questions.map((q) => `${q.question} (${q.reason})`)), "focused discovery");
    if (followUp.exitCode !== 0) throw new Error(`Focused Scout failed: ${followUp.stderr || followUp.output.slice(-2_000)}`);
    report = mergeScoutReports(report, parseJsonResponse<ScoutReport>(followUp.output, "scout"));
    state.scoutReportPath = await persistScoutReport(state, report);
    await saveState(state);
    await transition(state, "planning", { reason: "focused context collected" });
  }
}

async function runRole(ctx: ExtensionCommandContext, state: WorkflowState, role: "scout" | "planner", task: string, action: string): Promise<Awaited<ReturnType<typeof runAgent>>> {
  await appendEvent(state, "agent_started", { role, action });
  notify(ctx, `${role} started: ${action}.`);
  return runAgent(state.repositoryRoot, role, task, { signal: ctx.signal, onProgress: (message) => ctx.ui.setStatus("workflow", `${state.workflowId}: ${message}`) });
}

async function readScoutReport(state: WorkflowState): Promise<ScoutReport> {
  if (!state.scoutReportPath) throw new Error("Scout report is missing from workflow state.");
  return JSON.parse(await fs.readFile(state.scoutReportPath, "utf8")) as ScoutReport;
}

async function readConfigValue(root: string): Promise<WorkflowConfig> {
  try { return JSON.parse(await fs.readFile(path.join(root, ".pi", "workflow.config.json"), "utf8")) as WorkflowConfig; } catch { return {}; }
}

function mergeScoutReports(base: ScoutReport, next: ScoutReport): ScoutReport {
  const unique = <T>(items: T[], key: (item: T) => string): T[] => Array.from(new Map(items.map((item) => [key(item), item])).values());
  return { ...base, ...next, relevantFiles: unique([...base.relevantFiles, ...next.relevantFiles], (x) => x.path), codeExcerpts: [...base.codeExcerpts, ...next.codeExcerpts], callPaths: unique([...base.callPaths, ...next.callPaths], String), dataFlow: unique([...base.dataFlow, ...next.dataFlow], String), existingPatterns: unique([...base.existingPatterns, ...next.existingPatterns], String), tests: unique([...base.tests, ...next.tests], (x) => x.path), verificationCommands: unique([...base.verificationCommands, ...next.verificationCommands], String), architectureConstraints: unique([...base.architectureConstraints, ...next.architectureConstraints], String), risks: unique([...base.risks, ...next.risks], String), uncertainties: unique([...base.uncertainties, ...next.uncertainties], (x) => x.question) };
}

async function ensureNoActiveWorkflow(root: string): Promise<void> {
  try { const state = await loadActiveWorkflow(root); if (!["completed", "failed", "cancelled"].includes(state.stage)) throw new Error(`Workflow ${state.workflowId} is already active at stage ${state.stage}.`); } catch (error) { if (error instanceof Error && !/ENOENT|no such file/i.test(error.message)) throw error; }
}
function activeAgent(stage: WorkflowState["stage"]): string { return stage === "scouting" ? "scout" : ["planning", "revising_plan"].includes(stage) ? "planner" : "orchestrator"; }
function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void { ctx.ui.notify(message, level); }
async function failSafely(state: WorkflowState, error: unknown): Promise<void> { try { if (!["failed", "cancelled", "completed"].includes(state.stage)) await markTerminal(state, "failed", String(error)); } catch { /* retain original failure */ } }
