import * as fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import {
  parseJsonResponse,
  parseMarkdownResponse,
  parsePlannerResponse,
  parseTaskDecomposition,
  type AgentRunResult,
} from './agents.ts'
import {
  appendEvent,
  loadEpicEvents,
  persistImmutableJsonArtifact,
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
import {
  checkResultArtifactPath,
  currentTaskArtifactPath,
  implementationDiffArtifactPath,
  reviewResultArtifactPath,
} from './artifact-paths.ts'
import {
  implementerTask,
  plannerEpicPrompt,
  reviewerTask,
  scoutEpicPrompt,
  taskPlannerTask,
  taskReviewTask,
} from './prompts.ts'
import { applyPrerequisites, discoverPrerequisites } from './prerequisites.ts'
import { validateReviewResult } from './review-validation.ts'
import { runAgentActor } from './machines/actors.ts'
import { finishAgentRun, startAgentRun } from './agent-activity.ts'
import { resolveAgentProfile } from './agent-profiles.ts'
import { getTaskDiff, hashTaskDiff, summarizeDiff } from './diff.ts'
import {
  assertCleanWorktree,
  assertGitPreflight,
  bootstrapEpicGitignore,
  createCheckpoint,
  inspectApplicationWorktree,
  resolveGitCommit,
  RecoverableRepositoryError,
  inspectTaskChanges,
  validateTaskDelta,
} from './git-checkpoints.ts'
import { resolveAvailableCheckNames, runCheckSuite } from './checks.ts'
import { validateTaskCheckPolicies } from './task-check-policy.ts'
import type {
  CheckSuiteResult,
  PlannerContextRequest,
  ReviewResult,
  ScoutReport,
  EpicClock,
  EpicDomainState,
  EpicBoundaryView,
  EpicEvent,
  EpicTask,
  ResolvedEpicConfiguration,
  RecoveryDiagnostics,
} from './types.ts'

export interface EpicServices {
  ctx: ExtensionContext
  now(): string
  notify(message: string, level?: 'info' | 'warning' | 'error'): void
  classify(state: EpicDomainState): EpicDomainState
  scout(
    state: EpicDomainState,
    questions?: string[]
  ): Promise<{ state: EpicDomainState; report: ScoutReport }>
  plan(
    state: EpicDomainState,
    report: ScoutReport
  ): Promise<{ state: EpicDomainState; result: string | PlannerContextRequest }>
  approvePlan(state: EpicDomainState): Promise<EpicDomainState>
  reviewPlan(
    state: EpicDomainState,
    force: boolean
  ): Promise<{ state: EpicDomainState; revised: boolean }>
  decompose(state: EpicDomainState): Promise<EpicDomainState>
  prerequisites(state: EpicDomainState): Promise<EpicDomainState>
  preparePrerequisites(state: EpicDomainState): Promise<EpicDomainState>
  implement(state: EpicDomainState, feedback?: string): Promise<EpicDomainState>
  checks(
    state: EpicDomainState,
    suite: 'fast' | 'full' | 'final'
  ): Promise<{ state: EpicDomainState; result: CheckSuiteResult }>
  review(
    state: EpicDomainState,
    checks: CheckSuiteResult,
    semanticAttempt: number
  ): Promise<{ state: EpicDomainState; result: ReviewResult }>
  reviseTask(state: EpicDomainState): Promise<EpicDomainState>
  checkpointTask(state: EpicDomainState): Promise<EpicDomainState>
  recordRecovery(state: EpicDomainState, recovery: RecoveryDiagnostics): Promise<EpicDomainState>
  approveRecovery(state: EpicDomainState, recovery: RecoveryDiagnostics): Promise<EpicDomainState>
}

export interface EpicServiceDependencies {
  runAgentActor: typeof runAgentActor
}

interface TaskBaselineResolution {
  state: EpicDomainState
  recovered: boolean
  skipImplementer: boolean
}

function eventString(event: EpicEvent, field: string): string | undefined {
  const value = event.payload[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function recoveryError(reason: string): Error {
  return new Error(`Incomplete task recovery: ${reason}`)
}

function recoveryInvocationDecision(
  events: readonly EpicEvent[],
  task: EpicTask
): boolean {
  const starts = events
    .map((event, journalOrder) => ({ event, journalOrder }))
    .filter(({ event }) => event.type === 'agent_started')
    .filter(
      ({ event }) =>
        event.payload.role === 'implementer' && event.payload.taskId === task.id
    )

  if (!starts.length)
    throw recoveryError(
      `the event journal has no implementer start for task ${task.id}.`
    )

  const latest = starts[starts.length - 1]
  if (!latest)
    throw recoveryError(
      `the latest implementer start for task ${task.id} is missing.`
    )
  const invocationId = eventString(latest.event, 'invocationId')
  if (!invocationId)
    throw recoveryError(
      `the implementer start for task ${task.id} has no invocationId.`
    )

  const finishes = events
    .map((event, journalOrder) => ({ event, journalOrder }))
    .filter(
      ({ event, journalOrder }) =>
        journalOrder > latest.journalOrder &&
        event.type === 'agent_finished' &&
        event.payload.role === 'implementer' &&
        event.payload.taskId === task.id &&
        event.payload.invocationId === invocationId
    )
  const finish = finishes[finishes.length - 1]
  if (!finish) return false
  const exitCode = finish.event.payload.exitCode
  if (typeof exitCode !== 'number' || !Number.isInteger(exitCode))
    throw recoveryError(
      `the implementer completion for invocation ${invocationId} has an invalid exitCode.`
    )
  return exitCode === 0
}

async function resolveTaskBaseline(
  state: EpicDomainState,
  task: EpicTask
): Promise<TaskBaselineResolution> {
  const status = await inspectApplicationWorktree(state.repositoryRoot)
  if (state.taskBaselineSha) {
    const baselineSha = await resolveGitCommit(
      state.repositoryRoot,
      state.taskBaselineSha
    )
    const next = { ...state, taskBaselineSha: baselineSha }
    await validateTaskDelta(state.repositoryRoot, baselineSha, state.approvedTaskHeadSha)
    return { state: next, recovered: false, skipImplementer: false }
  }

  if (!status.changes.length) {
    await assertCleanWorktree(state.repositoryRoot)
    return {
      state: { ...state, taskBaselineSha: status.headSha },
      recovered: false,
      skipImplementer: false,
    }
  }

  const checkpoint = state.checkpoint
  if (!checkpoint) {
    throw recoveryError('the dirty worktree has no task checkpoint evidence.')
  }

  let checkpointSha: string
  let tagSha: string
  try {
    checkpointSha = await resolveGitCommit(state.repositoryRoot, checkpoint.sha)
    tagSha = await resolveGitCommit(state.repositoryRoot, checkpoint.tag)
  } catch (error) {
    throw recoveryError(
      `the latest checkpoint cannot be resolved: ${String(error)}`
    )
  }
  if (checkpointSha !== tagSha)
    throw recoveryError(
      'the latest checkpoint SHA and tag resolve to different commits.'
    )
  if (checkpointSha !== status.headSha)
    throw recoveryError(
      `HEAD ${status.headSha} does not match checkpoint ${checkpointSha}.`
    )

  const events = await loadEpicEvents(state)
  const skipImplementer = recoveryInvocationDecision(events, task)
  const next = { ...state, taskBaselineSha: checkpointSha }
  await validateTaskDelta(state.repositoryRoot, checkpointSha)
  return { state: next, recovered: true, skipImplementer }
}

async function readApprovedPlan(state: EpicDomainState): Promise<string> {
  if (!state.planApproved)
    throw new Error('The plan must be approved before this task phase.')
  if (!state.approvedPlanHash)
    throw new Error('Approved plan hash is missing from epic state.')
  const plan = await fs.readFile(state.planPath, 'utf8')
  if (hashPlan(plan) !== state.approvedPlanHash)
    throw new Error(
      'The approved plan changed after approval. Re-review and approve the plan again.'
    )
  return plan
}

export function createEpicServices(
  ctx: ExtensionContext,
  getBoundary: () => EpicBoundaryView,
  clock: EpicClock,
  configuration: ResolvedEpicConfiguration,
  dependencies: EpicServiceDependencies
): EpicServices {
  const notify = (
    message: string,
    level: 'info' | 'warning' | 'error' = 'info'
  ) => ctx.ui.notify(message, level)
  const agentFailure = (run: AgentRunResult): string =>
    run.failureReason || run.stderr || run.output.slice(-2_000)
  const runRole = async (
    state: EpicDomainState,
    role: Parameters<typeof runAgentActor>[0]['role'],
    prompt: string,
    action: string,
    taskId: string | undefined
  ): Promise<AgentRunResult> => {
    const profile = resolveAgentProfile(role, configuration)
    const timeoutMs = profile.timeoutMs ?? configuration.agentTimeoutMs
    const agentRunDirectory = path.join(
      state.repositoryRoot,
      '.pi',
      'epics',
      'runs',
      state.epicId,
      'agent-runs'
    )
    const invocationId = randomUUID()
    await appendEvent(
      state,
      getBoundary().stage,
      clock.now(),
      'agent_started',
      {
        invocationId,
        role,
        action,
        agentRunDirectory,
        ...(profile.provider === undefined
          ? {}
          : { provider: profile.provider }),
        ...(profile.model === undefined ? {} : { model: profile.model }),
        ...(profile.thinking === undefined
          ? {}
          : { thinking: profile.thinking }),
        ...(taskId === undefined ? {} : { taskId }),
      }
    )
    notify(`${role} started: ${action}.`)
    const runStartedAt = clock.nowMs()
    startAgentRun(
      invocationId,
      state.repositoryRoot,
      state.epicId,
      runStartedAt,
      taskId,
      role,
      action,
      {
        ...(profile.provider === undefined
          ? {}
          : { provider: profile.provider }),
        ...(profile.model === undefined ? {} : { model: profile.model }),
        ...(profile.thinking === undefined
          ? {}
          : { thinking: profile.thinking }),
      }
    )
    let result: AgentRunResult | undefined
    let failure: unknown
    try {
      try {
        result = await dependencies.runAgentActor({
          repositoryRoot: state.repositoryRoot,
          agentRunDirectory,
          role,
          prompt,
          profile,
          timeoutMs,
          signal: ctx.signal,
          onProgress: (message) =>
            ctx.ui.setStatus('epic', `${state.epicId}: ${message}`),
        })
      } catch (error) {
        failure = error
      }
      const durationMs = Math.max(0, clock.nowMs() - runStartedAt)
      if (failure !== undefined) {
        await appendEvent(
          state,
          getBoundary().stage,
          clock.now(),
          'agent_finished',
          {
            invocationId,
            role,
            action,
            ...(taskId === undefined ? {} : { taskId }),
            ...(profile.provider === undefined
              ? {}
              : { provider: profile.provider }),
            ...(profile.model === undefined ? {} : { model: profile.model }),
            ...(profile.thinking === undefined
              ? {}
              : { thinking: profile.thinking }),
            exitCode: 1,
            failureReason:
              failure instanceof Error ? failure.message : String(failure),
            durationMs,
          }
        )
        throw failure
      }
      if (result === undefined) {
        const error = new Error(`${role} agent finished without a result.`)
        await appendEvent(
          state,
          getBoundary().stage,
          clock.now(),
          'agent_finished',
          {
            invocationId,
            role,
            action,
            ...(taskId === undefined ? {} : { taskId }),
            ...(profile.provider === undefined
              ? {}
              : { provider: profile.provider }),
            ...(profile.model === undefined ? {} : { model: profile.model }),
            ...(profile.thinking === undefined
              ? {}
              : { thinking: profile.thinking }),
            exitCode: 1,
            failureReason: error.message,
            durationMs,
          }
        )
        throw error
      }
      await appendEvent(
        state,
        getBoundary().stage,
        clock.now(),
        'agent_finished',
        {
          invocationId,
          role,
          action,
          ...(taskId === undefined ? {} : { taskId }),
          provider: result.provider ?? profile.provider,
          model: result.model ?? profile.model,
          ...(profile.thinking === undefined
            ? {}
            : { thinking: profile.thinking }),
          exitCode: result.exitCode,
          stdoutLogPath: result.stdoutLogPath,
          ...(result.failureReason === undefined
            ? {}
            : { failureReason: result.failureReason }),
          ...(result.usage === undefined ? {} : { usage: result.usage }),
          durationMs,
        }
      )
      return result
    } finally {
      finishAgentRun(invocationId)
    }
  }
  return {
    ctx,
    now: () => clock.now(),
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
        questions.length ? 'focused discovery' : 'repository discovery',
        undefined
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
        'planning',
        undefined
      )
      if (run.exitCode !== 0)
        throw new Error(`Planner failed: ${agentFailure(run)}`)
      const result = parsePlannerResponse(run.output)
      if (typeof result !== 'string') {
        const max = state.maxScoutRounds
        if (state.scoutRound >= max)
          throw new Error(
            `Planner requested more Scout context after the maximum of ${max} rounds.`
          )
        return { state, result }
      }
      const next = { ...state }
      await writePlanRevision(next, result, clock.now())
      await fs.writeFile(next.planPath, `${result}\n`, 'utf8')
      return {
        state: next,
        result,
      }
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
        planApprovedAt: clock.now(),
        approvedPlanHash: hashPlan(plan),
      }
      await appendEvent(
        next,
        getBoundary().stage,
        clock.now(),
        'plan_approved',
        {
          revision: next.planRevision,
          hash: next.approvedPlanHash,
        }
      )
      return next
    },
    async reviewPlan(state, force) {
      const current = await fs.readFile(state.planPath, 'utf8')
      const instructions = extractReviewInstructions(current)
      if (!force && instructions.length === 0)
        return {
          state,
          revised: false,
        }
      const report = state.scoutReportPath
        ? (JSON.parse(
            await fs.readFile(state.scoutReportPath, 'utf8')
          ) as ScoutReport)
        : undefined
      if (!report) throw new Error('Scout report is missing from epic state.')
      const run = await runRole(
        state,
        'plan-reviewer',
        plannerEpicPrompt(state, report, current, instructions),
        'plan revision',
        undefined
      )
      if (run.exitCode !== 0)
        throw new Error(`Plan reviewer failed: ${agentFailure(run)}`)
      const revised = parseMarkdownResponse(run.output, 'plan-reviewer')
      validatePlanRevision(current, revised, instructions)
      const next = {
        ...state,
        planApproved: false,
        approvedPlanHash: undefined,
      }
      await writePlanRevision(next, revised, clock.now())
      await fs.writeFile(next.planPath, `${revised}\n`, 'utf8')
      return { state: next, revised: true }
    },
    async decompose(state) {
      const plan = await readApprovedPlan(state)
      const availableChecks = await resolveAvailableCheckNames(
        state.repositoryRoot,
        configuration
      )
      const finalAvailableChecks = await resolveAvailableCheckNames(
        state.repositoryRoot,
        configuration,
        ['fast', 'full', 'final']
      )
      let tasks: EpicTask[] | undefined
      let previousOutput = ''
      let errors: string[] = []
      for (
        let attempt = 0;
        attempt <= configuration.maxTaskPlanRepairs;
        attempt += 1
      ) {
        const run = await runRole(
          state,
          'task-planner',
          taskPlannerTask(
            state,
            plan,
            availableChecks,
            attempt === 0
              ? undefined
              : {
                  previousOutput,
                  errors,
                  repairAttempt: attempt,
                  maxRepairAttempts: configuration.maxTaskPlanRepairs,
                }
          ),
          attempt === 0
            ? 'task decomposition'
            : `task decomposition repair ${attempt}`,
          undefined
        )
        if (run.exitCode !== 0)
          throw new Error(`Task decomposition failed: ${agentFailure(run)}`)
        previousOutput = run.output
        try {
          const candidate = parseTaskDecomposition(run.output)
          const validation = validateTaskCheckPolicies(
            candidate,
            availableChecks,
            finalAvailableChecks
          )
          if (validation.valid) {
            tasks = candidate
            break
          }
          errors = validation.errors
        } catch (error) {
          errors = [error instanceof Error ? error.message : String(error)]
        }
        await appendEvent(
          state,
          getBoundary().stage,
          clock.now(),
          'task_decomposition_rejected',
          {
            attempt: attempt + 1,
            repairAttempt: attempt,
            maxRepairAttempts: configuration.maxTaskPlanRepairs,
            errors,
          }
        )
      }
      if (!tasks)
        throw new Error(
          `Task decomposition remained invalid after ${configuration.maxTaskPlanRepairs} repair attempts: ${errors.join(' ')}`
        )
      const next = {
        ...state,
        tasks,
        currentTaskIndex: 0,
        taskApproved: false,
      }
      next.taskPlanPath = await persistEpicTasks(next, tasks)
      await appendEvent(
        next,
        getBoundary().stage,
        clock.now(),
        'tasks_decomposed',
        {
          count: tasks.length,
          path: next.taskPlanPath,
        }
      )
      return next
    },
    async prerequisites(state) {
      if (!state.planApproved)
        throw new Error(
          'Cannot inspect prerequisites before the plan is approved.'
        )
      if (!state.tasks || state.tasks.length === 0)
        throw new Error(
          'Cannot inspect prerequisites before tasks are decomposed.'
        )
      await assertGitPreflight(state.repositoryRoot)
      await bootstrapEpicGitignore(state.repositoryRoot)
      const next = {
        ...state,
        prerequisites: await discoverPrerequisites(state.repositoryRoot),
      }
      if (!next.checkpoint) {
        const checkpoint = await createCheckpoint(
          next.repositoryRoot,
          next,
          'plan',
          0,
          []
        )
        next.checkpoint = { kind: 'plan', ordinal: 0, ...checkpoint }
      }
      return next
    },
    async preparePrerequisites(state) {
      await applyPrerequisites(
        state.repositoryRoot,
        state.prerequisites ?? [],
        configuration.commandTimeoutMs
      )
      return {
        ...state,
        prerequisitesApprovedAt: clock.now(),
      }
    },
    async implement(state, feedback = '') {
      const plan = await readApprovedPlan(state)
      if (!state.tasks || state.tasks.length === 0)
        throw new Error('Cannot implement a task before tasks are decomposed.')
      if (!state.tasks[state.currentTaskIndex])
        throw new Error(
          `Cannot implement missing task at index ${state.currentTaskIndex}.`
        )
      if (!state.taskApproved)
        throw new Error('Cannot implement a task before the task is approved.')
      const task = state.tasks[state.currentTaskIndex]
      if (task === undefined) {
        throw new Error(
          `Cannot implement missing task at index ${state.currentTaskIndex}.`
        )
      }
      const baseline = await resolveTaskBaseline(state, task)
      state = baseline.state
      const baselineSha = state.taskBaselineSha
      if (!baselineSha) throw new Error('Task baseline was not recorded.')
      const shouldRunImplementer =
        !baseline.skipImplementer || feedback.length > 0
      if (shouldRunImplementer) {
        const artifact = await fs.readFile(
          currentTaskArtifactPath(state),
          'utf8'
        )
        const run = await runRole(
          state,
          'implementer',
          implementerTask(state, plan, feedback, artifact),
          feedback ? 'bounded repair' : 'implementation',
          task.id
        )
        if (run.exitCode !== 0)
          throw new Error(`Implementer failed: ${agentFailure(run)}`)
      }
      await validateTaskDelta(state.repositoryRoot, baselineSha, state.approvedTaskHeadSha)
      const implementationAttempt = baseline.recovered
        ? Math.max(state.implementationAttempt + (feedback ? 0 : 1), 1)
        : state.implementationAttempt + (feedback ? 0 : 1)
      const next = {
        ...state,
        implementationAttempt,
      }
      const diff = await getTaskDiff(next.repositoryRoot, baselineSha)
      const taskId = task.id
      const summary = summarizeDiff(diff)
      next.lastDiffPath = await persistImmutableJsonArtifact(
        next,
        implementationDiffArtifactPath(
          next,
          next.implementationAttempt,
          randomUUID()
        ),
        { taskId, attempt: next.implementationAttempt, diff, summary }
      )
      await appendEvent(
        next,
        getBoundary().stage,
        clock.now(),
        'task_diff_updated',
        { taskId, ...summary }
      )
      return next
    },
    async checks(state, suite) {
      const result = await runCheckSuite(
        suite,
        state,
        clock.now(),
        configuration
      )
      const next = { ...state }
      next.lastCheckResultPath = await persistImmutableJsonArtifact(
        next,
        checkResultArtifactPath(next, suite, randomUUID()),
        result
      )
      await appendEvent(
        next,
        getBoundary().stage,
        clock.now(),
        'checks_completed',
        {
          suite,
          passed: result.passed,
          introducedFindings: result.introducedFindings.length,
        }
      )
      notify(`${suite} checks ${result.passed ? 'passed' : 'failed'}.`)
      return { state: next, result }
    },
    async review(state, checks, semanticAttempt) {
      const plan = await readApprovedPlan(state)
      if (!state.taskBaselineSha)
        throw new Error('Cannot review without a task baseline.')
      const diff = await getTaskDiff(state.repositoryRoot, state.taskBaselineSha)
      const taskChanges = await inspectTaskChanges(
        state.repositoryRoot,
        state.taskBaselineSha
      )
      const changedPaths = taskChanges.changes.map((change) => change.path)
      const artifact = await fs.readFile(currentTaskArtifactPath(state), 'utf8')
      const run = await runRole(
        state,
        'reviewer',
        reviewerTask(
          state,
          plan,
          diff,
          JSON.stringify(checks),
          artifact,
          changedPaths
        ),
        'semantic review',
        state.tasks?.[state.currentTaskIndex]?.id
      )
      if (run.exitCode !== 0)
        throw new Error(`Reviewer failed: ${agentFailure(run)}`)
      const parsed = parseJsonResponse<ReviewResult>(run.output, 'reviewer')
      const task = state.tasks?.[state.currentTaskIndex]
      if (task === undefined)
        throw new Error('Cannot review without a current task.')
      const result = validateReviewResult(parsed)
      const next = { ...state }
      next.reviewedTaskDiffHash = hashTaskDiff(diff)
      next.taskRevalidationRequired = false
      next.lastReviewResultPath = await persistImmutableJsonArtifact(
        next,
        reviewResultArtifactPath(next, semanticAttempt, randomUUID()),
        result
      )
      const criteriaCompleted = result.acceptanceCriteria.filter(
        (criterion) => criterion.status === 'met'
      ).length
      await appendEvent(
        next,
        getBoundary().stage,
        clock.now(),
        'task_review_completed',
        {
          taskId: task.id,
          criteriaCompleted,
          criteriaTotal: task.acceptanceCriteria.length,
        }
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
        'task revision',
        state.tasks?.[state.currentTaskIndex]?.id
      )
      if (run.exitCode !== 0)
        throw new Error(`Task reviewer failed: ${agentFailure(run)}`)
      const revised = parseMarkdownResponse(run.output, 'task-reviewer')
      if (extractReviewInstructions(revised).length)
        throw new Error(
          'Task reviewer left unresolved R: findings in the task artifact.'
        )
      await fs.writeFile(file, `${revised}\n`, 'utf8')
      const task = state.tasks?.[state.currentTaskIndex]
      if (task === undefined) {
        throw new Error('Cannot record a revision without a current task.')
      }
      await appendEvent(
        state,
        getBoundary().stage,
        clock.now(),
        'task_revised',
        { taskId: task.id }
      )
      return state
    },
    async checkpointTask(state) {
      const task = state.tasks?.[state.currentTaskIndex]
      if (!task || !state.taskBaselineSha)
        throw new Error('Cannot checkpoint without a current task baseline.')
      const paths = await validateTaskDelta(
        state.repositoryRoot,
        state.taskBaselineSha,
        state.approvedTaskHeadSha
      )
      const diff = await getTaskDiff(state.repositoryRoot, state.taskBaselineSha)
      const currentHash = hashTaskDiff(diff)
      if (!state.reviewedTaskDiffHash || currentHash !== state.reviewedTaskDiffHash) {
        const status = await inspectTaskChanges(state.repositoryRoot, state.taskBaselineSha)
        throw new RecoverableRepositoryError(
          'The application changed after semantic review. Approve the current changes to rerun checks and review before checkpointing.',
          'adopt-and-revalidate',
          state.taskBaselineSha,
          status.headSha,
          status.changes,
          true
        )
      }
      const checkpoint = await createCheckpoint(
        state.repositoryRoot,
        state,
        'task',
        state.currentTaskIndex + 1,
        paths
      )
      return {
        ...state,
        approvedTaskHeadSha: undefined,
        reviewedTaskDiffHash: undefined,
        taskRevalidationRequired: false,
        failureReason: undefined,
        checkpoint: {
          kind: 'task',
          ordinal: state.currentTaskIndex + 1,
          ...checkpoint,
        },
      }
    },
    async recordRecovery(state, recovery) {
      await appendEvent(state, getBoundary().stage, clock.now(), 'epic_recovery_requested', {
        operation: recovery.operation,
        reason: recovery.reason,
        action: recovery.action,
        baselineSha: recovery.baselineSha,
        candidateHeadSha: recovery.candidateHeadSha,
        changedPaths: recovery.changedPaths,
        requiresRevalidation: recovery.requiresRevalidation,
      })
      return { ...state, failureReason: recovery.reason }
    },
    async approveRecovery(state, recovery) {
      const next = { ...state }
      if (recovery.candidateHeadSha) {
        const status = await inspectApplicationWorktree(state.repositoryRoot)
        if (status.headSha !== recovery.candidateHeadSha) {
          throw new RecoverableRepositoryError(
            `HEAD changed after recovery was proposed: expected ${recovery.candidateHeadSha}, found ${status.headSha}.`,
            'retry', recovery.baselineSha ?? state.taskBaselineSha ?? status.headSha,
            status.headSha, status.changes, true
          )
        }
        next.approvedTaskHeadSha = status.headSha
      }
      next.taskRevalidationRequired = recovery.requiresRevalidation
      next.failureReason = undefined
      await appendEvent(next, getBoundary().stage, clock.now(), 'epic_recovery_approved', {
        operation: recovery.operation,
        action: recovery.action,
        candidateHeadSha: recovery.candidateHeadSha,
        changedPaths: recovery.changedPaths,
      })
      return next
    },
  }
}
