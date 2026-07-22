import type { PlanReviewInstruction, ScoutReport, WorkflowState } from "./types.ts";

export function scoutTask(state: WorkflowState, focusedQuestions: string[] = []): string {
  return `Investigate the repository for this task and return the exact JSON contract from your role prompt.\n\nTask:\n${state.task}\n\nRepository root: ${state.repositoryRoot}\nLimits: inspect at most 15 primary files, 30 excerpts, and 140 lines per excerpt.${focusedQuestions.length ? `\n\nThe Planner requested this focused follow-up context. Answer only these questions:\n${focusedQuestions.map((question) => `- ${question}`).join("\n")}` : ""}`;
}

export function plannerTask(state: WorkflowState, report: ScoutReport, currentPlan: string | null, instructions: PlanReviewInstruction[] = []): string {
  return [
    currentPlan ? "Revise the current plan using every human instruction." : "Create the initial implementation plan.",
    `Task:\n${state.task}`,
    `Scout report:\n${JSON.stringify(report)}`,
    currentPlan ? `Current plan:\n${currentPlan}` : "No current plan exists.",
    instructions.length ? `Human R: instructions:\n${instructions.map((item) => `- line ${item.lineNumber}: ${item.text}`).join("\n")}` : "No human review instructions were supplied.",
    "Return only the required plan Markdown. Do not mark it approved.",
  ].join("\n\n");
}

export function implementerTask(state: WorkflowState, plan: string, feedback = ""): string {
  return [
    "Implement the approved plan in the repository. Make the smallest complete change, preserve existing APIs unless the plan says otherwise, and do not modify plan.md or .pi/workflows.",
    `Task:\n${state.task}`,
    `Approved plan:\n${plan}`,
    feedback ? `Repair feedback:\n${feedback}` : "This is the initial implementation attempt.",
    "Run only safe, relevant local checks if useful. Return a concise summary of changes and checks; the workflow engine owns all stage transitions.",
  ].join("\n\n");
}

export function reviewerTask(state: WorkflowState, plan: string, diff: string, checks: string): string {
  return [
    "Review the implementation semantically against the approved plan and acceptance criteria. Do not modify files. Return valid JSON matching the ReviewResult contract from your role prompt.",
    `Task:\n${state.task}`,
    `Approved plan:\n${plan}`,
    `Implementation diff:\n${diff}`,
    `Deterministic check summary:\n${checks}`,
  ].join("\n\n");
}
