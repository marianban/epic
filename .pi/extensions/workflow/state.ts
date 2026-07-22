import { randomUUID } from "node:crypto";
import type { TaskComplexity, WorkflowStage, WorkflowState } from "./types.ts";

export const ALLOWED_TRANSITIONS: Record<WorkflowStage, WorkflowStage[]> = {
  idle: ["classifying"],
  classifying: ["scouting", "failed", "cancelled"],
  scouting: ["planning", "failed", "cancelled"],
  planning: ["scouting", "awaiting_plan_review", "failed", "cancelled"],
  awaiting_plan_review: ["revising_plan", "awaiting_plan_approval", "cancelled"],
  revising_plan: ["awaiting_plan_review", "failed", "cancelled"],
  awaiting_plan_approval: ["revising_plan", "checking_prerequisites", "cancelled"],
  checking_prerequisites: ["awaiting_prerequisite_approval", "implementing", "failed", "cancelled"],
  awaiting_prerequisite_approval: ["preparing_prerequisites", "cancelled"],
  preparing_prerequisites: ["implementing", "failed", "cancelled"],
  implementing: ["checking_prerequisites", "running_fast_checks", "failed", "cancelled"],
  running_fast_checks: ["repairing_fast_checks", "running_full_checks", "escalating", "failed"],
  repairing_fast_checks: ["running_fast_checks", "escalating", "failed"],
  running_full_checks: ["repairing_full_checks", "reviewing", "failed"],
  repairing_full_checks: ["running_full_checks", "escalating", "failed"],
  reviewing: ["repairing_review", "final_verification", "failed"],
  repairing_review: ["running_fast_checks", "escalating", "failed"],
  escalating: ["implementing", "awaiting_plan_review", "failed", "cancelled"],
  final_verification: ["completed", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function createWorkflowState(repositoryRoot: string, task: string, now = new Date().toISOString()): WorkflowState {
  const workflowId = `${now.replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  return {
    workflowId,
    task,
    repositoryRoot,
    stage: "idle",
    createdAt: now,
    updatedAt: now,
    taskComplexity: "moderate",
    scoutRound: 0,
    maxScoutRounds: 3,
    planPath: `${repositoryRoot}/plan.md`,
    planRevision: 0,
    planApproved: false,
    pendingHumanAction: "none",
    implementationAttempt: 0,
    fastRepairAttempt: 0,
    fullRepairAttempt: 0,
    semanticRepairAttempt: 0,
    maxFastRepairs: 2,
    maxFullRepairs: 1,
    maxSemanticRepairs: 2,
  };
}

export function canTransition(from: WorkflowStage, to: WorkflowStage): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(state: WorkflowState, next: WorkflowStage): void {
  if (!canTransition(state.stage, next)) {
    throw new Error(`Invalid workflow transition: ${state.stage} -> ${next}`);
  }
}

export function assertStage(state: WorkflowState, stages: WorkflowStage[]): void {
  if (!stages.includes(state.stage)) {
    throw new Error(`Command is not available in stage ${state.stage}; expected ${stages.join(", ")}`);
  }
}

export function assertApprovedPlan(state: WorkflowState): void {
  if (!state.planApproved || !state.approvedPlanHash) {
    throw new Error("Implementation is blocked until plan.md is explicitly approved.");
  }
}

export function classifyTask(task: string): TaskComplexity {
  const normalized = task.toLowerCase();
  const complexSignals = /(architect|migration|concurren|security|public api|cross[- ]module|distributed|persist|workflow)/;
  const simpleSignals = /\b(rename|typo|comment|small|one helper|single function)\b/;
  if (complexSignals.test(normalized)) return "complex";
  if (simpleSignals.test(normalized) && task.length < 140) return "simple";
  return "moderate";
}
