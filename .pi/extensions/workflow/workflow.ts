import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseJsonResponse, parseMarkdownResponse, parsePlannerResponse, parseTaskDecomposition, runAgent } from "./agents.ts";
import { appendEvent, loadActiveWorkflow, markTerminal, persistJsonArtifact, persistScoutReport, persistTask, persistWorkflowTasks, saveState, transition, writePlanRevision } from "./persistence.ts";
import { extractReviewInstructions, hashPlan, validatePlanCompleteness, validatePlanRevision } from "./plan-review.ts";
import { assertApprovedPlan, assertStage, classifyTask, createWorkflowState } from "./state.ts";
import { implementerTask, plannerTask, reviewerTask, scoutTask, taskDecompositionTask, taskReviewTask } from "./prompts.ts";
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
  const run = await runRole(ctx, state, "plan-reviewer", plannerTask(state, report, current, instructions), "plan revision");
  if (run.exitCode !== 0) throw new Error(`Plan reviewer revision failed: ${run.stderr || run.output.slice(-2_000)}`);
  const revised = parseMarkdownResponse(run.output, "plan-reviewer");
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
  await transition(state, "decomposing_tasks", { phase: "task_decomposition" });
  const decomposition = await runRole(ctx, state, "planner", taskDecompositionTask(state, plan), "task decomposition");
  if (decomposition.exitCode !== 0) throw new Error(`Task decomposition failed: ${decomposition.stderr || decomposition.output.slice(-2_000)}`);
  state.tasks = parseTaskDecomposition(decomposition.output);
  state.currentTaskIndex = 0;
  state.taskApproved = false;
  state.taskPlanPath = await persistWorkflowTasks(state, state.tasks);
  await appendEvent(state, "tasks_decomposed", { count: state.tasks.length, path: state.taskPlanPath });
  await transition(state, "checking_prerequisites", { phase: "prerequisites" });
  if (await checkAndGatePrerequisites(state, ctx)) return;
  await pauseForTaskApproval(state, ctx);
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
    if (state.implementationAttempt > 0) {
      await transition(state, "implementing", { phase: "implementation_after_prerequisites" });
      await executeImplementation(state, ctx, true);
    } else {
      await pauseForTaskApproval(state, ctx);
    }
  } catch (error) {
    await failSafely(state, error);
    notify(ctx, `Workflow ${state.workflowId} failed while preparing prerequisites: ${String(error)}`, "error");
    throw error;
  }
}

export async function resumeWorkflow(ctx: ExtensionCommandContext): Promise<void> {
  const state = await loadActiveWorkflow(ctx.cwd);
  if (["completed", "cancelled"].includes(state.stage)) { notify(ctx, `Workflow ${state.workflowId} is already ${state.stage}.`); return; }
  if (["awaiting_plan_review", "awaiting_plan_approval", "awaiting_task_approval", "awaiting_task_review"].includes(state.stage)) { notify(ctx, `Workflow ${state.workflowId} is paused at ${state.stage}. Pending action: ${state.pendingHumanAction ?? "none"}.`); return; }
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
  const task = state.tasks?.[state.currentTaskIndex];
  notify(ctx, [`Workflow: ${state.workflowId}`, `Stage: ${state.stage}`, `Active agent: ${activeAgent(state.stage)}`, `Plan: revision ${state.planRevision}, ${state.planApproved ? "approved" : "not approved"}`, task ? `Task: ${state.currentTaskIndex + 1}/${state.tasks?.length} ${task.id} — ${task.title}` : "Tasks: not decomposed", `Pending human action: ${state.pendingHumanAction ?? "none"}`].join("\n"));
}

export async function approveTask(ctx: ExtensionCommandContext): Promise<void> {
  const state = await loadActiveWorkflow(ctx.cwd);
  assertStage(state, ["awaiting_task_approval", "awaiting_task_review"]);
  const task = assertTaskManifest(state);
  const taskPath = path.join(state.repositoryRoot, ".pi", "workflows", "runs", state.workflowId, "tasks", `task-${String(state.currentTaskIndex + 1).padStart(3, "0")}.md`);
  const markdown = await fs.readFile(taskPath, "utf8");
  if (extractReviewInstructions(markdown).length > 0) throw new Error("Current task contains unresolved R: findings. Run /task-review first.");
  state.taskApproved = true;
  state.taskApprovedAt = new Date().toISOString();
  state.pendingHumanAction = "none";
  await appendEvent(state, "task_approved", { taskId: task.id, index: state.currentTaskIndex });
  if (state.stage === "awaiting_task_approval") {
    await saveState(state);
    await transition(state, "implementing", { taskId: task.id, phase: "implementation" });
    await executeImplementation(state, ctx);
    return;
  }
  if (state.currentTaskIndex + 1 >= (state.tasks?.length ?? 0)) {
    await transition(state, "final_verification", { phase: "all_tasks_approved" });
    const final = await runSuite(state, ctx, "final", "final_verification");
    if (!final.passed) {
      await markTerminal(state, "failed", "Final verification failed after task approval.");
      throw new Error("Final verification failed after task approval.");
    }
    await transition(state, "completed", { phase: "implementation" });
    await appendEvent(state, "workflow_completed", { implementationAttempt: state.implementationAttempt });
    notify(ctx, `Workflow ${state.workflowId} completed successfully.`);
    return;
  }
  state.currentTaskIndex += 1;
  state.taskApproved = false;
  state.fastRepairAttempt = 0;
  state.fullRepairAttempt = 0;
  state.semanticRepairAttempt = 0;
  await pauseForTaskApproval(state, ctx);
}

export async function reviseTask(ctx: ExtensionCommandContext): Promise<void> {
  const state = await loadActiveWorkflow(ctx.cwd);
  const preImplementationReview = state.stage === "awaiting_task_approval";
  assertStage(state, ["awaiting_task_approval", "awaiting_task_review"]);
  const task = assertTaskManifest(state);
  const taskPath = path.join(state.repositoryRoot, ".pi", "workflows", "runs", state.workflowId, "tasks", `task-${String(state.currentTaskIndex + 1).padStart(3, "0")}.md`);
  const instructions = extractReviewInstructions(await fs.readFile(taskPath, "utf8"));
  if (instructions.length === 0) throw new Error("Add R: findings to the current task artifact before running /task-review.");
  await transition(state, "revising_task", { taskId: task.id });
  if (preImplementationReview) {
    const currentTask = await fs.readFile(taskPath, "utf8");
    const run = await runRole(ctx, state, "task-reviewer", taskReviewTask(state, currentTask, instructions), "pre-implementation task revision");
    if (run.exitCode !== 0) throw new Error(`Task reviewer revision failed: ${run.stderr || run.output.slice(-2_000)}`);
    const revised = parseMarkdownResponse(run.output, "task-reviewer");
    if (extractReviewInstructions(revised).length > 0) throw new Error("Task reviewer left unresolved R: findings in the task artifact.");
    await fs.writeFile(taskPath, `${revised}\n`, "utf8");
    state.pendingHumanAction = "review_task";
    await saveState(state);
    await transition(state, "awaiting_task_approval", { taskId: task.id, reason: "task artifact revised" });
    notify(ctx, `Task ${task.id} was revised. Review it again, then run /task-approve or add more R: findings and run /task-review.`);
    return;
  }
  const feedback = instructions.map((item) => `line ${item.lineNumber}: ${item.text}`).join("\n");
  await runImplementer(state, ctx, await fs.readFile(state.planPath, "utf8"), `Human task review findings:\n${feedback}`);
  const taskMarkdown = await fs.readFile(taskPath, "utf8");
  await fs.writeFile(taskPath, `${taskMarkdown.split(/\r?\n/).map((line) => line.replace(/(?:^|\s)R:\s*.+?\s*$/, "").trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n")}\n`, "utf8");
  await persistDiff(state);
  state.pendingHumanAction = "none";
  await saveState(state);
  await transition(state, "implementing", { reason: "human task findings" });
  await executeImplementation(state, ctx, true);
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
    assertTaskManifest(state);
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

    state.pendingHumanAction = "approve_task";
    await saveState(state);
    await transition(state, "awaiting_task_review", { taskId: state.tasks?.[state.currentTaskIndex]?.id });
    notify(ctx, `Task ${state.currentTaskIndex + 1}/${state.tasks?.length ?? 0} passed automated and semantic review. Follow the manual review steps in the task artifact, then run /task-approve or add R: findings and run /task-review.`);
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

async function pauseForTaskApproval(state: WorkflowState, ctx: ExtensionCommandContext): Promise<void> {
  state.taskApproved = false;
  state.taskApprovedAt = undefined;
  state.pendingHumanAction = "review_task";
  await saveState(state);
  await transition(state, "awaiting_task_approval", { taskId: state.tasks?.[state.currentTaskIndex]?.id, phase: "pre_implementation_review" });
  notify(ctx, `Task ${state.currentTaskIndex + 1}/${state.tasks?.length ?? 0} is ready for human review. Review its task artifact, add R: comments if needed, then run /task-review or /task-approve.`);
}

async function runImplementer(state: WorkflowState, ctx: ExtensionCommandContext, plan: string, feedback = ""): Promise<void> {
  const taskArtifact = await readCurrentTaskArtifact(state);
  const run = await runRole(ctx, state, "implementer", implementerTask(state, plan, feedback, taskArtifact), feedback ? "bounded repair" : "implementation");
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
  const taskArtifact = await readCurrentTaskArtifact(state);
  const run = await runRole(ctx, state, "reviewer", reviewerTask(state, plan, diff, JSON.stringify(checks), taskArtifact), "semantic review");
  if (run.exitCode !== 0) throw new Error(`Reviewer failed: ${run.stderr || run.output.slice(-2_000)}`);
  const review = parseJsonResponse<ReviewResult>(run.output, "reviewer");
  if (typeof review.passed !== "boolean" || !Array.isArray(review.findings)) throw new Error("Reviewer returned an invalid review result.");
  state.lastReviewResultPath = await persistJsonArtifact(state, `reviews/review-${String(state.semanticRepairAttempt + 1).padStart(3, "0")}.json`, review);
  await appendEvent(state, "review_completed", { passed: review.passed, findings: review.findings.length });
  await saveState(state);
  notify(ctx, `Semantic review ${review.passed ? "passed" : "found issues"}.`);
  return review;
}

async function readCurrentTaskArtifact(state: WorkflowState): Promise<string> {
  const taskPath = path.join(state.repositoryRoot, ".pi", "workflows", "runs", state.workflowId, "tasks", `task-${String(state.currentTaskIndex + 1).padStart(3, "0")}.md`);
  return fs.readFile(taskPath, "utf8");
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

async function runRole(ctx: ExtensionCommandContext, state: WorkflowState, role: "scout" | "planner" | "plan-reviewer" | "task-reviewer" | "implementer" | "reviewer", task: string, action: string): Promise<Awaited<ReturnType<typeof runAgent>>> {
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
function activeAgent(stage: WorkflowState["stage"]): string { return stage === "scouting" ? "scout" : ["planning", "decomposing_tasks"].includes(stage) ? "planner" : stage === "revising_plan" ? "plan-reviewer" : stage === "revising_task" ? "task-reviewer" : ["implementing", "repairing_fast_checks", "repairing_full_checks", "repairing_review"].includes(stage) ? "implementer" : stage === "reviewing" ? "reviewer" : "orchestrator"; }
function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void { ctx.ui.notify(message, level); }
function assertTaskManifest(state: WorkflowState): NonNullable<WorkflowState["tasks"]>[number] {
  if (!state.tasks || state.tasks.length === 0 || !Number.isInteger(state.currentTaskIndex) || !state.tasks[state.currentTaskIndex]) {
    throw new Error("Persisted workflow state is incompatible with task-scoped execution: no valid task manifest is present. Start a new workflow; no compatibility migration was applied.");
  }
  return state.tasks[state.currentTaskIndex];
}
async function failSafely(state: WorkflowState, error: unknown): Promise<void> { try { if (!["failed", "cancelled", "completed"].includes(state.stage)) await markTerminal(state, "failed", String(error)); } catch { /* retain original failure */ } }
