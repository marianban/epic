import type {
  PlanReviewInstruction,
  ScoutReport,
  EpicDomainState,
} from './types.ts'
import { extractReviewInstructions } from './plan-review.ts'

export function scoutEpicPrompt(
  state: EpicDomainState,
  focusedQuestions: string[] = []
): string {
  return `Investigate the repository for this epic and return the exact JSON contract from your role prompt.\n\nEpic:\n${state.epic}\n\nRepository root: ${state.repositoryRoot}\nLimits: inspect at most 15 primary files, 30 excerpts, and 140 lines per excerpt.${focusedQuestions.length ? `\n\nThe Planner requested this focused follow-up context. Answer only these questions:\n${focusedQuestions.map((question) => `- ${question}`).join('\n')}` : ''}`
}

export function plannerEpicPrompt(
  state: EpicDomainState,
  report: ScoutReport,
  currentPlan: string | null,
  instructions: PlanReviewInstruction[] = []
): string {
  return [
    currentPlan
      ? 'Revise the current plan using every human instruction.'
      : 'Create the initial implementation plan.',
    `Epic:\n${state.epic}`,
    `Scout report:\n${JSON.stringify(report)}`,
    currentPlan ? `Current plan:\n${currentPlan}` : 'No current plan exists.',
    instructions.length
      ? `Human R: instructions:\n${instructions.map((item) => `- line ${item.lineNumber}: ${item.text}`).join('\n')}`
      : 'No human review instructions were supplied.',
    'Return only the required plan Markdown. Do not mark it approved.',
  ].join('\n\n')
}

export function implementerTask(
  state: EpicDomainState,
  plan: string,
  feedback = '',
  taskArtifact = ''
): string {
  const task = state.tasks?.[state.currentTaskIndex]
  const humanInstructions = extractReviewInstructions(taskArtifact)
  return [
    'Implement only the current approved task from the approved plan. Make the smallest complete change, preserve existing APIs unless the task says otherwise, and do not modify the run plan, task artifacts, or .pi/epics. You may write only scope.create and scope.modify paths; scope.read paths are immutable. Never delete a path unless it is in scope.delete. If the task artifact contains human R: instructions, treat every one as a mandatory implementation requirement and address them in the application code.',
    `Epic:\n${state.epic}`,
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
    'Run only safe, relevant local checks if useful. Return a concise summary of changes and checks; the epic engine owns all stage transitions.',
  ].join('\n\n')
}

export function reviewerTask(
  state: EpicDomainState,
  plan: string,
  diff: string,
  checks: string,
  taskArtifact = ''
): string {
  const task = state.tasks?.[state.currentTaskIndex]
  return [
    'Review only the current task semantically against its acceptance criteria using the implementation diff and deterministic check results. Do not perform or judge the manual review steps; they belong to the subsequent human checkpoint. When an acceptance criterion can only be confirmed by those manual steps and there is no independently evidenced code defect, give it status manual_review_pending, do not create a finding for the missing observation, and do not fail the review for that reason. Every actionable finding must describe a code or configuration repair and include at least one repairPaths entry containing only an exact current scope.modify path. Set passed=false only when there is an actionable finding or requiresPlanRevision=true. Do not modify files. Return valid JSON matching the ReviewResult contract from your role prompt.',
    `Epic:\n${state.epic}`,
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

export function taskPlannerTask(state: EpicDomainState, plan: string): string {
  return [
    'Decompose the approved implementation plan into bounded, cohesive tasks suitable for implementation by a less capable local LLM, preserving dependency order. Optimize for reliable execution rather than the fewest tasks. Each task should have one focused objective, limited context, explicit implementation guidance, and few unresolved decisions. Split setup from non-trivial feature work and split distinct behaviors, subsystems, lifecycle phases, or integration concerns when combining them would require broad reasoning. As a judgment aid, split a candidate with more than one substantial implementation concern or more than about five distinct behavioral acceptance criteria. Intermediate milestones are valid when they leave the repository consistent and verifiable. Do not split merely by file or layer, and keep each behavior with its focused tests. Merge only mechanical or trivial adjacent tasks when the combination remains suitable for one focused local-model run. Treat the approved plan as authoritative: do not redesign it, expand its scope, or create a separate plan. Return JSON only with shape {tasks:[{id,title,objective,scope:{read,modify,create,delete},implementation,acceptanceCriteria,verification,manualReviewSteps,risks,requiredChecks,deferredChecks,reason}]}. For each task, requiredChecks lists checks that must pass before the task advances, deferredChecks lists checks that are intentionally not applicable until a later task, and reason explains the decision. When the approved plan creates project-specific generated output or local tooling artifacts, include the necessary `.gitignore` change in the setup or tooling task that introduces those artifacts. Use stable check names such as install, diff-check, typecheck, lint, focused-tests, tests, build, and fallow. The install check verifies package dependencies using the repository lockfile when present. Deferred checks remain mandatory during final verification; never defer a check without a concrete dependency-based reason.',
    `Epic:\n${state.epic}`,
    `Approved plan:\n${plan}`,
    'Every task must have observable acceptance criteria and concrete manual review steps for that intermediate or final milestone. Write implementation steps for the local model: name relevant paths, components, interfaces, behaviors, invariants, and connections to prior tasks when known. Avoid broad instructions or single steps that bundle multiple subsystems. Before returning, split tasks that require broad reasoning and merge tasks that are too trivial for a separate run. A compact low-risk change may be one task; a small application built from scratch usually should not be.',
  ].join('\n\n')
}

export function taskReviewTask(
  state: EpicDomainState,
  taskMarkdown: string,
  instructions: PlanReviewInstruction[]
): string {
  return [
    'Revise only the current task artifact in response to every human R: instruction. Do not modify application code, the run plan, or epic state. Preserve unaffected task details, including the check policy, update scope, implementation, acceptance criteria, verification, manual review steps, and risks consistently, remove handled R: lines, and return the complete task Markdown only.',
    `Epic:\n${state.epic}`,
    `Current task artifact:\n${taskMarkdown}`,
    `Human R: instructions:\n${instructions.map((item) => `- line ${item.lineNumber}: ${item.text}`).join('\n')}`,
  ].join('\n\n')
}
