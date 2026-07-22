import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseJsonResponse, parseMarkdownResponse, parsePlannerResponse, runAgent } from "./agents.ts";
import { appendEvent, loadActiveWorkflow, markTerminal, persistJsonArtifact, persistScoutReport, persistTask, saveState, transition, writePlanRevision } from "./persistence.ts";
import { extractReviewInstructions, hashPlan, validatePlanCompleteness, validatePlanRevision } from "./plan-review.ts";
import { assertApprovedPlan, assertStage, classifyTask, createWorkflowState } from "./state.ts";
import { implementerTask, plannerTask, reviewerTask, scoutTask } from "./prompts.ts";
import type { CheckSuiteResult, ReviewResult, ScoutReport, WorkflowConfig, WorkflowState } from "./types.ts";
import { logWorkflow } from "./logger.ts";
import { getCurrentDiff } from "./diff.ts";
import { runCheckSuite } from "./checks.ts";
import { applyPrerequisites, discoverPrerequisites } from "./prerequisites.ts";

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
  await transition(state, "checking_prerequisites", { phase: "prerequisites" });
  if (await checkAndGatePrerequisites(state, ctx)) return;
  await transition(state, "implementing", { phase: "implementation" });
  await executeImplementation(state, ctx);
}

export async function approvePrerequisites(ctx: ExtensionCommandContext): Promise<void> {
  const state = await loadActiveWorkflow(ctx.cwd);
  assertStage(state, ["awaiting_prerequisite_approval"]);
  const config = await readConfigValue(state.repositoryRoot);
  try {
    await transition(state, "preparing_prerequisites");
    await applyPrerequisites(state.repositoryRoot, state.prerequisites ?? [], config.commandTimeoutMs ?? 120_000);
    state.prerequisitesApprovedAt = new Date().toISOString();
    state.pendingHumanAction = "none";
    await saveState(state);
    await appendEvent(state, "prerequisites_applied", { commands: (state.prerequisites ?? []).map((item) => item.command) });
    await transition(state, "implementing", { phase: "implementation" });
    await executeImplementation(state, ctx, state.implementationAttempt > 0);
  } catch (error) {
    await failSafely(state, error);
    notify(ctx, `Workflow ${state.workflowId} failed while preparing prerequisites: ${String(error)}`, "error");
    throw error;
  }
}

export async function resumeWorkflow(ctx: ExtensionCommandContext): Promise<void> {
  const state = await loadActiveWorkflow(ctx.cwd);
  if (["completed", "cancelled"].includes(state.stage)) { notify(ctx, `Workflow ${state.workflowId} is already ${state.stage}.`); return; }
  if (["awaiting_plan_review", "awaiting_plan_approval"].includes(state.stage)) { notify(ctx, `Workflow ${state.workflowId} is paused at ${state.stage}. Pending action: ${state.pendingHumanAction ?? "none"}.`); return; }
  if (state.stage === "awaiting_prerequisite_approval") { notify(ctx, `Workflow ${state.workflowId} is paused for prerequisite approval. Run /workflow-approve-prerequisites to continue, or /workflow-cancel.`); return; }
  if (state.stage === "escalating") { state.pendingHumanAction = "none"; await saveState(state); await transition(state, "implementing", { reason: "escalation resolved by resume" }); await executeImplementation(state, ctx); return; }
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

async function executeImplementation(state: WorkflowState, ctx: ExtensionCommandContext, implementationComplete = false): Promise<void> {
  try {
    assertApprovedPlan(state);
    const config = await readConfigValue(state.repositoryRoot);
    state.maxFastRepairs = config.maxFastRepairs ?? state.maxFastRepairs;
    state.maxFullRepairs = config.maxFullRepairs ?? state.maxFullRepairs;
    state.maxSemanticRepairs = config.maxSemanticRepairs ?? state.maxSemanticRepairs;
    await saveState(state);
    const plan = await fs.readFile(state.planPath, "utf8");
    if (!implementationComplete) {
      state.implementationAttempt += 1;
      await saveState(state);
      await runImplementer(state, ctx, plan);
      await persistDiff(state);

      await transition(state, "checking_prerequisites", { phase: "post_implementation_prerequisites" });
      if (await checkAndGatePrerequisites(state, ctx)) return;
      await transition(state, "implementing", { phase: "checks" });
    }

    let fast = await runSuite(state, ctx, "fast", "running_fast_checks");
    while (!fast.passed) {
      if (state.fastRepairAttempt >= state.maxFastRepairs) {
        await pauseForEscalation(state, ctx, "Fast checks exceeded the repair limit.");
        return;
      }
      state.fastRepairAttempt += 1;
      await saveState(state);
      await transition(state, "repairing_fast_checks", { attempt: state.fastRepairAttempt });
      await runImplementer(state, ctx, plan, formatCheckFeedback(fast));
      await persistDiff(state);
      fast = await runSuite(state, ctx, "fast", "running_fast_checks");
    }

    let full = await runSuite(state, ctx, "full", "running_full_checks");
    while (!full.passed) {
      if (state.fullRepairAttempt >= state.maxFullRepairs) {
        await pauseForEscalation(state, ctx, "Full checks exceeded the repair limit.");
        return;
      }
      state.fullRepairAttempt += 1;
      await saveState(state);
      await transition(state, "repairing_full_checks", { attempt: state.fullRepairAttempt });
      await runImplementer(state, ctx, plan, formatCheckFeedback(full));
      await persistDiff(state);
      full = await runSuite(state, ctx, "full", "running_full_checks");
    }

    let review = await runSemanticReview(state, ctx, plan, full);
    while (!review.passed) {
      if (state.semanticRepairAttempt >= state.maxSemanticRepairs) {
        await pauseForEscalation(state, ctx, "Semantic review exceeded the repair limit.");
        return;
      }
      state.semanticRepairAttempt += 1;
      await saveState(state);
      await transition(state, "repairing_review", { attempt: state.semanticRepairAttempt });
      await runImplementer(state, ctx, plan, formatReviewFeedback(review));
      await persistDiff(state);
      fast = await runSuite(state, ctx, "fast", "running_fast_checks");
      while (!fast.passed) {
        if (state.fastRepairAttempt >= state.maxFastRepairs) {
          await pauseForEscalation(state, ctx, "Fast checks after semantic repair exceeded the repair limit.");
          return;
        }
        state.fastRepairAttempt += 1;
        await saveState(state);
        await transition(state, "repairing_fast_checks", { attempt: state.fastRepairAttempt, reason: "semantic repair broke fast checks" });
        await runImplementer(state, ctx, plan, formatCheckFeedback(fast));
        await persistDiff(state);
        fast = await runSuite(state, ctx, "fast", "running_fast_checks");
      }
      full = await runSuite(state, ctx, "full", "running_full_checks");
      while (!full.passed) {
        if (state.fullRepairAttempt >= state.maxFullRepairs) {
          await pauseForEscalation(state, ctx, "Full checks after semantic repair exceeded the repair limit.");
          return;
        }
        state.fullRepairAttempt += 1;
        await saveState(state);
        await transition(state, "repairing_full_checks", { attempt: state.fullRepairAttempt, reason: "semantic repair broke full checks" });
        await runImplementer(state, ctx, plan, formatCheckFeedback(full));
        await persistDiff(state);
        full = await runSuite(state, ctx, "full", "running_full_checks");
      }
      review = await runSemanticReview(state, ctx, plan, full);
    }

    const final = await runSuite(state, ctx, "final", "final_verification");
    if (!final.passed) throw new Error("Final verification failed.");
    await transition(state, "completed", { phase: "implementation" });
    await appendEvent(state, "workflow_completed", { implementationAttempt: state.implementationAttempt });
    notify(ctx, `Workflow ${state.workflowId} completed successfully.`);
  } catch (error) {
    await failSafely(state, error);
    notify(ctx, `Workflow ${state.workflowId} failed: ${String(error)}`, "error");
    throw error;
  }
}

async function checkAndGatePrerequisites(state: WorkflowState, ctx: ExtensionCommandContext): Promise<boolean> {
  const prerequisites = await discoverPrerequisites(state.repositoryRoot);
  state.prerequisites = prerequisites;
  if (prerequisites.length === 0) {
    state.pendingHumanAction = "none";
    await saveState(state);
    await appendEvent(state, "prerequisites_checked", { required: false });
    notify(ctx, "Prerequisite checks passed.");
    return false;
  }
  state.pendingHumanAction = "approve_prerequisites";
  await saveState(state);
  await appendEvent(state, "prerequisites_checked", { required: true, commands: prerequisites.map((item) => item.command) });
  await transition(state, "awaiting_prerequisite_approval");
  notify(ctx, `Prerequisites require approval:\n${prerequisites.map((item) => `- ${item.command}: ${item.reason}`).join("\n")}\nRun /workflow-approve-prerequisites to apply them, or /workflow-cancel.`, "warning");
  return true;
}

async function runImplementer(state: WorkflowState, ctx: ExtensionCommandContext, plan: string, feedback = ""): Promise<void> {
  const run = await runRole(ctx, state, "implementer", implementerTask(state, plan, feedback), feedback ? "bounded repair" : "implementation");
  if (run.exitCode !== 0) throw new Error(`Implementer failed: ${run.stderr || run.output.slice(-2_000)}`);
  await appendEvent(state, "implementation_result", { attempt: state.implementationAttempt, output: run.output.slice(-4_000) });
}

async function persistDiff(state: WorkflowState): Promise<void> {
  const diff = await getCurrentDiff(state.repositoryRoot);
  state.lastDiffPath = await persistJsonArtifact(state, `diffs/implementation-${String(state.implementationAttempt).padStart(3, "0")}.json`, { attempt: state.implementationAttempt, diff });
  await saveState(state);
}

async function runSuite(state: WorkflowState, ctx: ExtensionCommandContext, suite: "fast" | "full" | "final", stage: WorkflowState["stage"]): Promise<CheckSuiteResult> {
  if (state.stage !== stage) await transition(state, stage, { suite });
  const result = await runCheckSuite(suite, state);
  state.lastCheckResultPath = await persistJsonArtifact(state, `checks/${suite}-${Date.now()}.json`, result);
  await appendEvent(state, "checks_completed", { suite, passed: result.passed, introducedFindings: result.introducedFindings.length });
  await saveState(state);
  notify(ctx, `${suite} checks ${result.passed ? "passed" : "failed"}.`);
  return result;
}

async function runSemanticReview(state: WorkflowState, ctx: ExtensionCommandContext, plan: string, checks: CheckSuiteResult): Promise<ReviewResult> {
  await transition(state, "reviewing", { reason: "deterministic checks passed" });
  const diff = await getCurrentDiff(state.repositoryRoot);
  const run = await runRole(ctx, state, "reviewer", reviewerTask(state, plan, diff, JSON.stringify(checks)), "semantic review");
  if (run.exitCode !== 0) throw new Error(`Reviewer failed: ${run.stderr || run.output.slice(-2_000)}`);
  const review = parseJsonResponse<ReviewResult>(run.output, "reviewer");
  if (typeof review.passed !== "boolean" || !Array.isArray(review.findings)) throw new Error("Reviewer returned an invalid review result.");
  state.lastReviewResultPath = await persistJsonArtifact(state, `reviews/review-${String(state.semanticRepairAttempt + 1).padStart(3, "0")}.json`, review);
  await appendEvent(state, "review_completed", { passed: review.passed, findings: review.findings.length });
  await saveState(state);
  notify(ctx, `Semantic review ${review.passed ? "passed" : "found issues"}.`);
  return review;
}

async function pauseForEscalation(state: WorkflowState, ctx: ExtensionCommandContext, reason: string): Promise<void> {
  state.pendingHumanAction = "resolve_escalation";
  await saveState(state);
  await transition(state, "escalating", { reason });
  notify(ctx, `${reason} Review the artifacts and run /workflow-resume to retry, or /workflow-cancel.`, "warning");
}

function formatCheckFeedback(result: CheckSuiteResult): string {
  return JSON.stringify({ suite: result.suite, checks: result.checks.filter((check) => !check.passed).map((check) => ({ name: check.name, command: check.command, stdout: check.stdoutPreview, stderr: check.stderrPreview, findings: check.findings })) });
}

function formatReviewFeedback(review: ReviewResult): string {
  return JSON.stringify({ summary: review.summary, findings: review.findings.filter((finding) => ["blocker", "major"].includes(finding.severity)) });
}

async function runRole(ctx: ExtensionCommandContext, state: WorkflowState, role: "scout" | "planner" | "implementer" | "reviewer", task: string, action: string): Promise<Awaited<ReturnType<typeof runAgent>>> {
  await appendEvent(state, "agent_started", { role, action });
  await logWorkflow(state, "info", "Agent started", { role, action, task });
  notify(ctx, `${role} started: ${action}.`);
  try {
    const result = await runAgent(state.repositoryRoot, role, task, {
      signal: ctx.signal,
      onProgress: (message) => {
        void logWorkflow(state, "debug", message, { role, action });
        ctx.ui.setStatus("workflow", `${state.workflowId}: ${message}`);
      },
    });
    await logWorkflow(state, result.exitCode === 0 ? "info" : "error", "Agent finished", {
      role,
      action,
      exitCode: result.exitCode,
      usage: result.usage,
      output: result.output,
      stderr: result.stderr,
    });
    return result;
  } catch (error) {
    await logWorkflow(state, "error", "Agent failed to run", { role, action, error: String(error) });
    throw error;
  }
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
function activeAgent(stage: WorkflowState["stage"]): string { return stage === "scouting" ? "scout" : ["planning", "revising_plan"].includes(stage) ? "planner" : ["implementing", "repairing_fast_checks", "repairing_full_checks", "repairing_review"].includes(stage) ? "implementer" : stage === "reviewing" ? "reviewer" : "orchestrator"; }
function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void { ctx.ui.notify(message, level); }
async function failSafely(state: WorkflowState, error: unknown): Promise<void> { try { if (!["failed", "cancelled", "completed"].includes(state.stage)) await markTerminal(state, "failed", String(error)); } catch { /* retain original failure */ } }
