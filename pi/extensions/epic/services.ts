import * as fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
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
  persistEpicTasks,
  writePlanRevision,
} from './persistence.ts'
import {
  extractReviewInstructions,
  hashPlan,
  validatePlanForApproval,
  validatePlanRevision,
} from './plan-review.ts'
import { currentTaskArtifactPath } from './artifact-paths.ts'
import {
  implementerTask,
  plannerEpicPrompt,
  reviewerTask,
  scoutEpicPrompt,
  taskDecompositionTask,
  taskReviewTask,
} from './prompts.ts'
import { applyPrerequisites, discoverPrerequisites } from './prerequisites.ts'
import { runAgentActor } from './machines/actors.ts'
import { finishAgentRun, startAgentRun } from './agent-activity.ts'
import { getCurrentDiff } from './diff.ts'
import { runCheckSuite } from './checks.ts'
import type {
  CheckSuiteResult,
  PlannerContextRequest,
  ReviewResult,
  ScoutReport,
  EpicConfig,
  EpicState,
} from './types.ts'

export interface EpicServices {
  ctx: ExtensionCommandContext
  notify(message: string, level?: 'info' | 'warning' | 'error'): void
  classify(state: EpicState): EpicState
  scout(
    state: EpicState,
    questions?: string[]
  ): Promise<{ state: EpicState; report: ScoutReport }>
  plan(
    state: EpicState,
    report: ScoutReport
  ): Promise<{ state: EpicState; result: string | PlannerContextRequest }>
  approvePlan(state: EpicState): Promise<EpicState>
  reviewPlan(
    state: EpicState,
    force: boolean
  ): Promise<{ state: EpicState; revised: boolean }>
  decompose(state: EpicState): Promise<EpicState>
  prerequisites(state: EpicState): Promise<EpicState>
  preparePrerequisites(state: EpicState): Promise<EpicState>
  implement(state: EpicState, feedback?: string): Promise<EpicState>
  checks(
    state: EpicState,
    suite: 'fast' | 'full' | 'final'
  ): Promise<{ state: EpicState; result: CheckSuiteResult }>
  review(
    state: EpicState,
    checks: CheckSuiteResult
  ): Promise<{ state: EpicState; result: ReviewResult }>
  reviseTask(state: EpicState): Promise<EpicState>
}

export function createEpicServices(
  ctx: ExtensionCommandContext
): EpicServices {
  const notify = (
    message: string,
    level: 'info' | 'warning' | 'error' = 'info'
  ) => ctx.ui.notify(message, level)
  const agentFailure = (run: AgentRunResult): string =>
    run.failureReason || run.stderr || run.output.slice(-2_000)
  const runRole = async (
    state: EpicState,
    role: Parameters<typeof runAgentActor>[0]['role'],
    prompt: string,
    action: string
  ): Promise<AgentRunResult> => {
    const agentRunDirectory = path.join(
      state.repositoryRoot,
      '.pi',
      'epics',
      'runs',
      state.epicId,
      'agent-runs'
    )
    await appendEvent(state, 'agent_started', {
      role,
      action,
      agentRunDirectory,
    })
    notify(`${role} started: ${action}.`)
    const runId = randomUUID()
    const runStartedAt = Date.now()
    startAgentRun(runId, state.repositoryRoot, state.epicId, runStartedAt)
    let result: AgentRunResult | undefined
    let failure: unknown
    let failed = false
    try {
      result = await runAgentActor({
        repositoryRoot: state.repositoryRoot,
        agentRunDirectory,
        role,
        prompt,
        signal: ctx.signal,
        onProgress: (message) =>
          ctx.ui.setStatus('epic', `${state.epicId}: ${message}`),
      })
    } catch (error) {
      failed = true
      failure = error
    }
    const durationMs = Math.max(0, Date.now() - runStartedAt)
    finishAgentRun(runId)
    if (failed) {
      await appendEvent(state, 'agent_finished', {
        role,
        action,
        exitCode: 1,
        failureReason:
          failure instanceof Error ? failure.message : String(failure),
        durationMs,
      })
      throw failure
    }
    if (result === undefined) {
      throw new Error(`${role} agent finished without a result.`)
    }
    await appendEvent(state, 'agent_finished', {
      role,
      action,
      exitCode: result.exitCode,
      stdoutLogPath: result.stdoutLogPath,
      failureReason: result.failureReason,
      usage: result.usage,
      durationMs,
    })
    return result
  }
  const config = async (root: string): Promise<EpicConfig> => {
    try {
      return JSON.parse(
        await fs.readFile(
          path.join(root, '.pi', 'epic.config.json'),
          'utf8'
        )
      ) as EpicConfig
    } catch {
      return {}
    }
  }
  return {
    ctx,
    notify,
    classify: (state) => ({
      ...state,
      epicComplexity: state.epic.toLowerCase().includes('migration')
        ? 'complex'
        : state.epic.length < 140
          ? 'simple'
          : 'moderate',
    }),
    async scout(state, questions = []) {
      const next = { ...state, scoutRound: state.scoutRound + 1 }
      const run = await runRole(
        next,
        'scout',
        scoutEpicPrompt(next, questions),
        questions.length ? 'focused discovery' : 'repository discovery'
      )
      if (run.exitCode !== 0)
        throw new Error(`Scout failed: ${agentFailure(run)}`)
      const report = parseJsonResponse<ScoutReport>(run.output, 'scout')
      next.scoutReportPath = await persistScoutReport(next, report)
      return { state: next, report }
    },
    async plan(state, report) {
      const run = await runRole(
        state,
        'planner',
        plannerEpicPrompt(state, report, null),
        'planning'
      )
      if (run.exitCode !== 0)
        throw new Error(`Planner failed: ${agentFailure(run)}`)
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
      const validation = validatePlanForApproval(plan)
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
        throw new Error('Scout report is missing from epic state.')
      const run = await runRole(
        state,
        'plan-reviewer',
        plannerEpicPrompt(state, report, current, instructions),
        'plan revision'
      )
      if (run.exitCode !== 0)
        throw new Error(`Plan reviewer failed: ${agentFailure(run)}`)
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
        throw new Error(`Task decomposition failed: ${agentFailure(run)}`)
      const tasks = parseTaskDecomposition(run.output)
      const next = {
        ...state,
        tasks,
        currentTaskIndex: 0,
        taskApproved: false,
      }
      next.taskPlanPath = await persistEpicTasks(next, tasks)
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
      const artifact = await fs.readFile(currentTaskArtifactPath(state), 'utf8')
      const run = await runRole(
        state,
        'implementer',
        implementerTask(state, plan, feedback, artifact),
        feedback ? 'bounded repair' : 'implementation'
      )
      if (run.exitCode !== 0)
        throw new Error(`Implementer failed: ${agentFailure(run)}`)
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
      const artifact = await fs.readFile(currentTaskArtifactPath(state), 'utf8')
      const run = await runRole(
        state,
        'reviewer',
        reviewerTask(state, plan, diff, JSON.stringify(checks), artifact),
        'semantic review'
      )
      if (run.exitCode !== 0)
        throw new Error(`Reviewer failed: ${agentFailure(run)}`)
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
      const file = currentTaskArtifactPath(state)
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
        throw new Error(`Task reviewer failed: ${agentFailure(run)}`)
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
