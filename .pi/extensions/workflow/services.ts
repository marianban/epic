import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import {
  parseJsonResponse,
  parseMarkdownResponse,
  parsePlannerResponse,
  parseTaskDecomposition,
  type AgentRunResult,
} from './agents.ts'
import {
  appendEvent,
  persistJsonArtifact,
  persistScoutReport,
  persistWorkflowTasks,
  writePlanRevision,
} from './persistence.ts'
import {
  extractReviewInstructions,
  hashPlan,
  validatePlanCompleteness,
  validatePlanRevision,
} from './plan-review.ts'
import {
  implementerTask,
  plannerTask,
  reviewerTask,
  scoutTask,
  taskDecompositionTask,
  taskReviewTask,
} from './prompts.ts'
import { applyPrerequisites, discoverPrerequisites } from './prerequisites.ts'
import { runAgentActor } from './machines/actors.ts'
import { getCurrentDiff } from './diff.ts'
import { runCheckSuite } from './checks.ts'
import type {
  CheckSuiteResult,
  PlannerContextRequest,
  ReviewResult,
  ScoutReport,
  WorkflowConfig,
  WorkflowState,
  WorkflowTask,
} from './types.ts'

export interface WorkflowServices {
  ctx: ExtensionCommandContext
  notify(message: string, level?: 'info' | 'warning' | 'error'): void
  classify(state: WorkflowState): WorkflowState
  scout(
    state: WorkflowState,
    questions?: string[]
  ): Promise<{ state: WorkflowState; report: ScoutReport }>
  plan(
    state: WorkflowState,
    report: ScoutReport
  ): Promise<{ state: WorkflowState; result: string | PlannerContextRequest }>
  approvePlan(state: WorkflowState): Promise<WorkflowState>
  reviewPlan(
    state: WorkflowState,
    force: boolean
  ): Promise<{ state: WorkflowState; revised: boolean }>
  decompose(state: WorkflowState): Promise<WorkflowState>
  prerequisites(state: WorkflowState): Promise<WorkflowState>
  preparePrerequisites(state: WorkflowState): Promise<WorkflowState>
  implement(state: WorkflowState, feedback?: string): Promise<WorkflowState>
  checks(
    state: WorkflowState,
    suite: 'fast' | 'full' | 'final'
  ): Promise<{ state: WorkflowState; result: CheckSuiteResult }>
  review(
    state: WorkflowState,
    checks: CheckSuiteResult
  ): Promise<{ state: WorkflowState; result: ReviewResult }>
  reviseTask(state: WorkflowState): Promise<WorkflowState>
}

export function createWorkflowServices(
  ctx: ExtensionCommandContext
): WorkflowServices {
  const notify = (
    message: string,
    level: 'info' | 'warning' | 'error' = 'info'
  ) => ctx.ui.notify(message, level)
  const runRole = async (
    state: WorkflowState,
    role: Parameters<typeof runAgentActor>[0]['role'],
    task: string,
    action: string
  ): Promise<AgentRunResult> => {
    await appendEvent(state, 'agent_started', { role, action })
    notify(`${role} started: ${action}.`)
    const result = await runAgentActor({
      repositoryRoot: state.repositoryRoot,
      role,
      task,
      signal: ctx.signal,
      onProgress: (message) =>
        ctx.ui.setStatus('workflow', `${state.workflowId}: ${message}`),
    })
    await appendEvent(state, 'agent_finished', {
      role,
      action,
      exitCode: result.exitCode,
      usage: result.usage,
    })
    return result
  }
  const currentTaskPath = (state: WorkflowState) =>
    path.join(
      state.repositoryRoot,
      '.pi',
      'workflows',
      'runs',
      state.workflowId,
      'tasks',
      `task-${String(state.currentTaskIndex + 1).padStart(3, '0')}.md`
    )
  const config = async (root: string): Promise<WorkflowConfig> => {
    try {
      return JSON.parse(
        await fs.readFile(
          path.join(root, '.pi', 'workflow.config.json'),
          'utf8'
        )
      ) as WorkflowConfig
    } catch {
      return {}
    }
  }
  const merge = (a: ScoutReport, b: ScoutReport): ScoutReport => ({
    ...a,
    ...b,
    relevantFiles: [
      ...new Map(
        [...a.relevantFiles, ...b.relevantFiles].map((x) => [x.path, x])
      ).values(),
    ],
    codeExcerpts: [...a.codeExcerpts, ...b.codeExcerpts],
    callPaths: [...new Set([...a.callPaths, ...b.callPaths])],
    dataFlow: [...new Set([...a.dataFlow, ...b.dataFlow])],
    existingPatterns: [
      ...new Set([...a.existingPatterns, ...b.existingPatterns]),
    ],
    tests: [
      ...new Map([...a.tests, ...b.tests].map((x) => [x.path, x])).values(),
    ],
    verificationCommands: [
      ...new Set([...a.verificationCommands, ...b.verificationCommands]),
    ],
    architectureConstraints: [
      ...new Set([...a.architectureConstraints, ...b.architectureConstraints]),
    ],
    risks: [...new Set([...a.risks, ...b.risks])],
    uncertainties: [
      ...new Map(
        [...a.uncertainties, ...b.uncertainties].map((x) => [x.question, x])
      ).values(),
    ],
  })
  return {
    ctx,
    notify,
    classify: (state) => ({
      ...state,
      taskComplexity: state.task.toLowerCase().includes('migration')
        ? 'complex'
        : state.task.length < 140
          ? 'simple'
          : 'moderate',
    }),
    async scout(state, questions = []) {
      const next = { ...state, scoutRound: state.scoutRound + 1 }
      const run = await runRole(
        next,
        'scout',
        scoutTask(next, questions),
        questions.length ? 'focused discovery' : 'repository discovery'
      )
      if (run.exitCode !== 0)
        throw new Error(
          `Scout failed: ${run.stderr || run.output.slice(-2_000)}`
        )
      const report = parseJsonResponse<ScoutReport>(run.output, 'scout')
      next.scoutReportPath = await persistScoutReport(next, report)
      return { state: next, report }
    },
    async plan(state, report) {
      const run = await runRole(
        state,
        'planner',
        plannerTask(state, report, null),
        'planning'
      )
      if (run.exitCode !== 0)
        throw new Error(
          `Planner failed: ${run.stderr || run.output.slice(-2_000)}`
        )
      const result = parsePlannerResponse(run.output)
      if (typeof result !== 'string') {
        const max =
          (await config(state.repositoryRoot)).maxScoutRounds ??
          state.maxScoutRounds
        if (state.scoutRound >= max)
          throw new Error(
            `Planner requested more Scout context after the maximum of ${max} rounds.`
          )
        return { state, result }
      }
      const next = { ...state }
      await writePlanRevision(next, result)
      await fs.writeFile(next.planPath, `${result}\n`, 'utf8')
      return { state: next, result }
    },
    async approvePlan(state) {
      const plan = await fs.readFile(state.planPath, 'utf8')
      if (extractReviewInstructions(plan).length)
        throw new Error(
          'plan.md still contains unresolved R: comments. Run /plan-review first.'
        )
      const validation = validatePlanCompleteness(plan)
      if (!validation.valid)
        throw new Error(`Cannot approve plan: ${validation.errors.join(' ')}`)
      const next = {
        ...state,
        planApproved: true,
        planApprovedAt: new Date().toISOString(),
        approvedPlanHash: hashPlan(plan),
        pendingHumanAction: 'none' as const,
      }
      await appendEvent(next, 'plan_approved', {
        revision: next.planRevision,
        hash: next.approvedPlanHash,
      })
      return next
    },
    async reviewPlan(state, force) {
      const current = await fs.readFile(state.planPath, 'utf8')
      const instructions = extractReviewInstructions(current)
      if (!force && instructions.length === 0)
        return {
          state: { ...state, pendingHumanAction: 'approve_plan' },
          revised: false,
        }
      const report = state.scoutReportPath
        ? (JSON.parse(
            await fs.readFile(state.scoutReportPath, 'utf8')
          ) as ScoutReport)
        : undefined
      if (!report)
        throw new Error('Scout report is missing from workflow state.')
      const run = await runRole(
        state,
        'plan-reviewer',
        plannerTask(state, report, current, instructions),
        'plan revision'
      )
      if (run.exitCode !== 0)
        throw new Error(
          `Plan reviewer failed: ${run.stderr || run.output.slice(-2_000)}`
        )
      const revised = parseMarkdownResponse(run.output, 'plan-reviewer')
      validatePlanRevision(current, revised, instructions)
      const next = {
        ...state,
        planApproved: false,
        approvedPlanHash: undefined,
        pendingHumanAction: 'review_plan' as const,
      }
      await writePlanRevision(next, revised)
      await fs.writeFile(next.planPath, `${revised}\n`, 'utf8')
      return { state: next, revised: true }
    },
    async decompose(state) {
      const plan = await fs.readFile(state.planPath, 'utf8')
      const run = await runRole(
        state,
        'planner',
        taskDecompositionTask(state, plan),
        'task decomposition'
      )
      if (run.exitCode !== 0)
        throw new Error(
          `Task decomposition failed: ${run.stderr || run.output.slice(-2_000)}`
        )
      const tasks = parseTaskDecomposition(run.output)
      const next = {
        ...state,
        tasks,
        currentTaskIndex: 0,
        taskApproved: false,
      }
      next.taskPlanPath = await persistWorkflowTasks(next, tasks)
      return next
    },
    async prerequisites(state) {
      const next = {
        ...state,
        prerequisites: await discoverPrerequisites(state.repositoryRoot),
      }
      return next
    },
    async preparePrerequisites(state) {
      const cfg = await config(state.repositoryRoot)
      await applyPrerequisites(
        state.repositoryRoot,
        state.prerequisites ?? [],
        cfg.commandTimeoutMs ?? 120_000
      )
      return {
        ...state,
        prerequisitesApprovedAt: new Date().toISOString(),
        pendingHumanAction: 'none',
      }
    },
    async implement(state, feedback = '') {
      const plan = await fs.readFile(state.planPath, 'utf8')
      const artifact = await fs.readFile(currentTaskPath(state), 'utf8')
      const run = await runRole(
        state,
        'implementer',
        implementerTask(state, plan, feedback, artifact),
        feedback ? 'bounded repair' : 'implementation'
      )
      if (run.exitCode !== 0)
        throw new Error(
          `Implementer failed: ${run.stderr || run.output.slice(-2_000)}`
        )
      const next = {
        ...state,
        implementationAttempt: state.implementationAttempt + (feedback ? 0 : 1),
      }
      const diff = await getCurrentDiff(next.repositoryRoot)
      next.lastDiffPath = await persistJsonArtifact(
        next,
        `diffs/implementation-${String(next.implementationAttempt).padStart(3, '0')}.json`,
        { attempt: next.implementationAttempt, diff }
      )
      return next
    },
    async checks(state, suite) {
      const result = await runCheckSuite(suite, state)
      const next = { ...state }
      next.lastCheckResultPath = await persistJsonArtifact(
        next,
        `checks/${suite}-${Date.now()}.json`,
        result
      )
      await appendEvent(next, 'checks_completed', {
        suite,
        passed: result.passed,
        introducedFindings: result.introducedFindings.length,
      })
      notify(`${suite} checks ${result.passed ? 'passed' : 'failed'}.`)
      return { state: next, result }
    },
    async review(state, checks) {
      const plan = await fs.readFile(state.planPath, 'utf8')
      const diff = await getCurrentDiff(state.repositoryRoot)
      const artifact = await fs.readFile(currentTaskPath(state), 'utf8')
      const run = await runRole(
        state,
        'reviewer',
        reviewerTask(state, plan, diff, JSON.stringify(checks), artifact),
        'semantic review'
      )
      if (run.exitCode !== 0)
        throw new Error(
          `Reviewer failed: ${run.stderr || run.output.slice(-2_000)}`
        )
      const result = parseJsonResponse<ReviewResult>(run.output, 'reviewer')
      if (typeof result.passed !== 'boolean' || !Array.isArray(result.findings))
        throw new Error('Reviewer returned an invalid review result.')
      const next = { ...state }
      next.lastReviewResultPath = await persistJsonArtifact(
        next,
        `reviews/review-${String(next.semanticRepairAttempt + 1).padStart(3, '0')}.json`,
        result
      )
      return { state: next, result }
    },
    async reviseTask(state) {
      const file = currentTaskPath(state)
      const markdown = await fs.readFile(file, 'utf8')
      const instructions = extractReviewInstructions(markdown)
      if (!instructions.length)
        throw new Error(
          'Add R: findings to the current task artifact before running /task-review.'
        )
      const run = await runRole(
        state,
        'task-reviewer',
        taskReviewTask(state, markdown, instructions),
        'task revision'
      )
      if (run.exitCode !== 0)
        throw new Error(
          `Task reviewer failed: ${run.stderr || run.output.slice(-2_000)}`
        )
      const revised = parseMarkdownResponse(run.output, 'task-reviewer')
      if (extractReviewInstructions(revised).length)
        throw new Error(
          'Task reviewer left unresolved R: findings in the task artifact.'
        )
      await fs.writeFile(file, `${revised}\n`, 'utf8')
      return { ...state, pendingHumanAction: 'review_task' }
    },
  }
}
