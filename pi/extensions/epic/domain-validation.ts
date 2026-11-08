import type { DevServerLaunchSpec, EpicDomainState, EpicTask, Prerequisite } from './types.ts'
import { validateDevServerLaunchSpec } from './dev-server.ts'

function fail(source: string, field: string): never {
  throw new Error(`${source}: invalid ${field}.`)
}
function record(value: unknown, source: string, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(source, field)
  return value as Record<string, unknown>
}
function string(value: unknown, source: string, field: string): string {
  if (typeof value !== 'string') fail(source, field)
  return value
}
function boolean(value: unknown, source: string, field: string): boolean {
  if (typeof value !== 'boolean') fail(source, field)
  return value
}
function integer(value: unknown, source: string, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) fail(source, field)
  return value as number
}
function strings(value: unknown, source: string, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) fail(source, field)
  return value as string[]
}
function optionalString(value: unknown, source: string, field: string): string | undefined {
  if (value === undefined) return undefined
  return string(value, source, field)
}
function checkpoint(value: unknown, source: string): EpicDomainState['checkpoint'] {
  if (value === undefined) return undefined
  const item = record(value, source, 'checkpoint')
  const kind = string(item.kind, source, 'checkpoint.kind')
  if (kind !== 'plan' && kind !== 'task') fail(source, 'checkpoint.kind')
  return { kind, ordinal: integer(item.ordinal, source, 'checkpoint.ordinal'), sha: string(item.sha, source, 'checkpoint.sha'), tag: string(item.tag, source, 'checkpoint.tag') }
}
function devServer(value: unknown, source: string): DevServerLaunchSpec | undefined {
  if (value === undefined) return undefined
  try {
    return validateDevServerLaunchSpec(value, true)
  } catch (error) {
    throw new Error(`${source}: invalid devServer.`, { cause: error })
  }
}
function task(value: unknown, source: string, index: number): EpicTask {
  const item = record(value, source, `tasks[${index}]`)
  const files = record(item.files, source, `tasks[${index}].files`)
  return {
    id: string(item.id, source, `tasks[${index}].id`), title: string(item.title, source, `tasks[${index}].title`), objective: string(item.objective, source, `tasks[${index}].objective`),
    files: { context: strings(files.context, source, `tasks[${index}].files.context`), expectedChanges: strings(files.expectedChanges, source, `tasks[${index}].files.expectedChanges`) },
    implementation: strings(item.implementation, source, `tasks[${index}].implementation`), acceptanceCriteria: strings(item.acceptanceCriteria, source, `tasks[${index}].acceptanceCriteria`), verification: strings(item.verification, source, `tasks[${index}].verification`), manualReviewSteps: strings(item.manualReviewSteps, source, `tasks[${index}].manualReviewSteps`), risks: strings(item.risks, source, `tasks[${index}].risks`), requiredChecks: strings(item.requiredChecks, source, `tasks[${index}].requiredChecks`), deferredChecks: strings(item.deferredChecks, source, `tasks[${index}].deferredChecks`), reason: string(item.reason, source, `tasks[${index}].reason`),
  }
}
function prerequisite(value: unknown, source: string, index: number): Prerequisite {
  const item = record(value, source, `prerequisites[${index}]`)
  const kind = string(item.kind, source, `prerequisites[${index}].kind`)
  const command = string(item.command, source, `prerequisites[${index}].command`)
  if (!['git', 'node_dependencies'].includes(kind) || !['git init', 'npm ci', 'npm install', 'pnpm install', 'yarn install'].includes(command)) fail(source, `prerequisites[${index}]`)
  return { kind: kind as Prerequisite['kind'], command: command as Prerequisite['command'], reason: string(item.reason, source, `prerequisites[${index}].reason`) }
}

export function parseEpicDomainState(value: unknown, source: string): EpicDomainState {
  const state = record(value, source, 'domain state')
  const complexity = string(state.epicComplexity, source, 'epicComplexity')
  if (!['simple', 'moderate', 'complex'].includes(complexity)) fail(source, 'epicComplexity')
  const tasks = state.tasks === undefined ? undefined : (Array.isArray(state.tasks) ? state.tasks.map((item, index) => task(item, source, index)) : fail(source, 'tasks'))
  const prerequisites = state.prerequisites === undefined ? undefined : (Array.isArray(state.prerequisites) ? state.prerequisites.map((item, index) => prerequisite(item, source, index)) : fail(source, 'prerequisites'))
  const epicComplexity: EpicDomainState['epicComplexity'] = complexity === 'simple' ? 'simple' : complexity === 'moderate' ? 'moderate' : 'complex'
  return {
    lastVerificationReportPath: optionalString(state.lastVerificationReportPath, source, 'lastVerificationReportPath'),
    verificationReadiness: state.verificationReadiness === undefined ? undefined : (['verified', 'issues_remaining', 'needs_manual_confirmation'].includes(String(state.verificationReadiness)) ? state.verificationReadiness as EpicDomainState['verificationReadiness'] : fail(source, 'verificationReadiness')),
    epicId: string(state.epicId, source, 'epicId'), epic: string(state.epic, source, 'epic'), repositoryRoot: string(state.repositoryRoot, source, 'repositoryRoot'), epicComplexity,
    scoutRound: integer(state.scoutRound, source, 'scoutRound'), maxScoutRounds: integer(state.maxScoutRounds, source, 'maxScoutRounds'), scoutReportPath: optionalString(state.scoutReportPath, source, 'scoutReportPath'), planPath: string(state.planPath, source, 'planPath'), planRevision: integer(state.planRevision, source, 'planRevision'), planApproved: boolean(state.planApproved, source, 'planApproved'), planApprovedAt: optionalString(state.planApprovedAt, source, 'planApprovedAt'), approvedPlanHash: optionalString(state.approvedPlanHash, source, 'approvedPlanHash'), taskPlanPath: optionalString(state.taskPlanPath, source, 'taskPlanPath'), tasks, currentTaskIndex: integer(state.currentTaskIndex, source, 'currentTaskIndex'), taskApproved: boolean(state.taskApproved, source, 'taskApproved'), taskApprovedAt: optionalString(state.taskApprovedAt, source, 'taskApprovedAt'), prerequisites, prerequisitesApprovedAt: optionalString(state.prerequisitesApprovedAt, source, 'prerequisitesApprovedAt'), implementationAttempt: integer(state.implementationAttempt, source, 'implementationAttempt'), maxAcceptancePlanRepairs: integer(state.maxAcceptancePlanRepairs, source, 'maxAcceptancePlanRepairs'), maxRepairsPerItem: integer(state.maxRepairsPerItem, source, 'maxRepairsPerItem'), maxTaskInfrastructureRetries: integer(state.maxTaskInfrastructureRetries, source, 'maxTaskInfrastructureRetries'), taskVerificationTimeoutMs: integer(state.taskVerificationTimeoutMs, source, 'taskVerificationTimeoutMs'), lastCheckResultPath: optionalString(state.lastCheckResultPath, source, 'lastCheckResultPath'), lastReviewResultPath: optionalString(state.lastReviewResultPath, source, 'lastReviewResultPath'), lastDiffPath: optionalString(state.lastDiffPath, source, 'lastDiffPath'), devServer: devServer(state.devServer, source), lastBrowserSmokeResultPath: optionalString(state.lastBrowserSmokeResultPath, source, 'lastBrowserSmokeResultPath'), taskBaselineSha: optionalString(state.taskBaselineSha, source, 'taskBaselineSha'), approvedTaskHeadSha: optionalString(state.approvedTaskHeadSha, source, 'approvedTaskHeadSha'), reviewedTaskDiffHash: optionalString(state.reviewedTaskDiffHash, source, 'reviewedTaskDiffHash'), taskRevalidationRequired: state.taskRevalidationRequired === undefined ? undefined : boolean(state.taskRevalidationRequired, source, 'taskRevalidationRequired'), checkpoint: checkpoint(state.checkpoint, source), failureReason: optionalString(state.failureReason, source, 'failureReason'),
  }
}

export function domainFromActorSnapshot(snapshot: unknown): EpicDomainState {
  const actor = record(snapshot, 'actor snapshot', 'snapshot')
  const context = record(actor.context, 'actor snapshot', 'context')
  return parseEpicDomainState(context.state, 'actor snapshot context.state')
}
