import type {
  PlanReviewInstruction,
  ScoutReport,
  WorkflowState,
} from './types.ts'
import { extractReviewInstructions } from './plan-review.ts'

export function scoutTask(
  state: WorkflowState,
  focusedQuestions: string[] = []
): string {
  return `Investigate the repository for this task and return the exact JSON contract from your role prompt.\n\nTask:\n${state.task}\n\nRepository root: ${state.repositoryRoot}\nLimits: inspect at most 15 primary files, 30 excerpts, and 140 lines per excerpt.${focusedQuestions.length ? `\n\nThe Planner requested this focused follow-up context. Answer only these questions:\n${focusedQuestions.map((question) => `- ${question}`).join('\n')}` : ''}`
}

export function plannerTask(
  state: WorkflowState,
  report: ScoutReport,
  currentPlan: string | null,
  instructions: PlanReviewInstruction[] = []
): string {
  return [
    currentPlan
      ? 'Revise the current plan using every human instruction.'
      : 'Create the initial implementation plan.',
    `Task:\n${state.task}`,
    `Scout report:\n${JSON.stringify(report)}`,
    currentPlan ? `Current plan:\n${currentPlan}` : 'No current plan exists.',
    instructions.length
      ? `Human R: instructions:\n${instructions.map((item) => `- line ${item.lineNumber}: ${item.text}`).join('\n')}`
      : 'No human review instructions were supplied.',
    'Return only the required plan Markdown. Do not mark it approved.',
  ].join('\n\n')
}

export function implementerTask(
  state: WorkflowState,
  plan: string,
  feedback = '',
  taskArtifact = ''
): string {
  const task = state.tasks?.[state.currentTaskIndex]
  const humanInstructions = extractReviewInstructions(taskArtifact)
  return [
    'Implement only the current approved task from the approved plan. Make the smallest complete change, preserve existing APIs unless the task says otherwise, and do not modify plan.md, task artifacts, or .pi/workflows. If the task artifact contains human R: instructions, treat every one as a mandatory implementation requirement and address them in the application code.',
    `Task:\n${state.task}`,
    `Approved plan:\n${plan}`,
    task
      ? `Current task:\n${JSON.stringify(task)}`
      : 'No task manifest is available.',
    taskArtifact
      ? `Human-approved task artifact:\n${taskArtifact}`
      : 'No separate task artifact was supplied.',
    humanInstructions.length
      ? `Human R: implementation instructions:\n${humanInstructions.map((item) => `- line ${item.lineNumber}: ${item.text}`).join('\n')}`
      : 'No human R: implementation instructions were supplied.',
    feedback
      ? `Repair feedback:\n${feedback}`
      : 'This is the initial implementation attempt.',
    'Run only safe, relevant local checks if useful. Return a concise summary of changes and checks; the workflow engine owns all stage transitions.',
  ].join('\n\n')
}

export function reviewerTask(
  state: WorkflowState,
  plan: string,
  diff: string,
  checks: string,
  taskArtifact = ''
): string {
  const task = state.tasks?.[state.currentTaskIndex]
  return [
    'Review only the current task semantically against its acceptance criteria and manual review steps. Do not modify files. Return valid JSON matching the ReviewResult contract from your role prompt.',
    `Task:\n${state.task}`,
    `Approved plan:\n${plan}`,
    task
      ? `Current task:\n${JSON.stringify(task)}`
      : 'No task manifest is available.',
    taskArtifact
      ? `Human-approved task artifact:\n${taskArtifact}`
      : 'No separate task artifact was supplied.',
    `Implementation diff:\n${diff}`,
    `Deterministic check summary:\n${checks}`,
  ].join('\n\n')
}

export function taskDecompositionTask(
  state: WorkflowState,
  plan: string
): string {
  return [
    'Break the approved implementation plan into the smallest independently implementable and reviewable tasks, preserving dependency order. Return JSON only with shape {tasks:[{id,title,objective,scope:{read,modify,create,delete},implementation,acceptanceCriteria,verification,manualReviewSteps,risks,requiredChecks,deferredChecks,reason}]}. For each task, requiredChecks lists checks that must pass before the task advances, deferredChecks lists checks that are intentionally not applicable until a later task, and reason explains the decision. Use stable check names such as diff-check, typecheck, lint, focused-tests, tests, build, and fallow. Deferred checks remain mandatory during final verification; never defer a check without a concrete dependency-based reason.',
    `Task:\n${state.task}`,
    `Approved plan:\n${plan}`,
    'Every task must have observable acceptance criteria and concrete manual review steps. Avoid mixing unrelated concerns.',
  ].join('\n\n')
}

export function taskReviewTask(
  state: WorkflowState,
  taskMarkdown: string,
  instructions: PlanReviewInstruction[]
): string {
  return [
    'Revise only the current task artifact in response to every human R: instruction. Do not modify application code, plan.md, or workflow state. Preserve unaffected task details, including the check policy, update scope, implementation, acceptance criteria, verification, manual review steps, and risks consistently, remove handled R: lines, and return the complete task Markdown only.',
    `Workflow task:\n${state.task}`,
    `Current task artifact:\n${taskMarkdown}`,
    `Human R: instructions:\n${instructions.map((item) => `- line ${item.lineNumber}: ${item.text}`).join('\n')}`,
  ].join('\n\n')
}
